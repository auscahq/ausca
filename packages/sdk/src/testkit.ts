import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
  address,
  base64Header,
  x402Challenge,
  x402Settlement,
} from "@ausca-internal/payable/testkit";

export * from "@ausca-internal/payable/testkit";

// An in-process Ausca-shaped service for client, CLI, and MCP tests: one
// active offer with a real catalog document, published input schema, payable
// route, and invocation read. Payment behaves like the kernel testkit
// resource: unsigned requests get a challenge, signed retries settle.

export interface AuscaServiceOptions {
  /** Price in atomic USDC units (6 decimals). Defaults to $0.01. */
  readonly amountAtomic?: string;
}

export interface AuscaService {
  readonly origin: string;
  readonly requests: { signed: number; unsigned: number };
  readonly artifactRequests: ReadonlyArray<{
    authorization?: string;
    body: Record<string, unknown>;
  }>;
  close(): Promise<void>;
}

const INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: { message: { type: "string", minLength: 1 } },
};

function catalogDocument(origin: string): Record<string, unknown> {
  return {
    schema: "ausca.catalog.v1",
    contract: {
      operations: [
        { method: "POST", operation_id: "Echo", path: "/v1/echo", summary: "Echo one message" },
        {
          method: "GET",
          operation_id: "GetInvocation",
          path: "/v1/invocations/{invocation_id}",
          summary: "Read invocation state",
        },
      ],
    },
    mcp: {
      tools: [
        {
          name: "ausca_echo",
          operation_id: "Echo",
          title: "Echo one message",
          description: "Admit or replay one paid Echo invocation.",
          read_only: false,
          idempotent: true,
        },
      ],
    },
    offers: [
      {
        offer_id: "echo.test",
        title: "Echo Test",
        description: "Echo one message back, paid per call.",
        revision: "echo-r1",
        revision_digest: `sha256:${"11".repeat(32)}`,
        route: { method: "POST", path: "/v1/echo" },
        artifact: { input_mode: "none" },
        input_schema: {
          digest: `sha256:${"22".repeat(32)}`,
          public_path: "/schemas/offers/echo.input.schema.json",
        },
        output_schema: { digest: `sha256:${"33".repeat(32)}`, public_path: "/schemas/offers/echo.output.schema.json" },
        price: { currency: "USD", model: "fixed", minimum_minor: 1, maximum_minor: 1, policy_digest: `sha256:${"44".repeat(32)}` },
      },
    ],
  };
}

export async function startAuscaService(options?: AuscaServiceOptions): Promise<AuscaService> {
  const amount = options?.amountAtomic ?? "10000";
  const requests = { signed: 0, unsigned: 0 };
  const artifactRequests: Array<{
    authorization?: string;
    body: Record<string, unknown>;
  }> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const origin = `http://127.0.0.1:${address(server)}`;
      const path = (request.url ?? "/").split("?")[0];
      const json = (status: number, body: unknown, headers?: Record<string, string>) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(body));
      };
      if (request.method === "GET" && path === "/catalog.json") {
        return json(200, catalogDocument(origin));
      }
      if (request.method === "GET" && path === "/schemas/offers/echo.input.schema.json") {
        return json(200, INPUT_SCHEMA);
      }
      if (request.method === "GET" && path?.startsWith("/v1/invocations/")) {
        return json(200, {
          invocation_id: path.split("/").pop(),
          state: "completed",
        });
      }
      if (request.method === "POST" && path?.startsWith("/v1/artifacts/") && path.endsWith("/access")) {
        if (!request.headers["idempotency-key"]) {
          return json(400, { status: "error", code: "invalid_request", message: "Request is invalid." });
        }
        // Access repeats the artifact evidence so the caller verifies the
        // downloaded bytes; the URL is not proof of content.
        return json(200, {
          status: "ready",
          artifact: {
            artifact_ref: decodeURIComponent(path.split("/")[3] ?? ""),
            content_digest: `sha256:${"c".repeat(64)}`,
            media_type: "application/json",
            size_bytes: 70_000,
            created_at: "2026-09-06T00:00:00Z",
            download_url: "https://artifacts.example/o/1?sig=2",
            expires_at: "2026-09-06T00:01:00Z",
          },
        });
      }
      if (request.method === "POST" && path === "/v1/artifacts") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
        artifactRequests.push({
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          body,
        });
        const data = Buffer.from(String(body.data_base64), "base64");
        // Ingress mints a storage identity the caller cannot derive from its
        // own bytes, exactly as the live service does.
        const mintedRef = `runx:artifact:sha256:${createHash("sha256")
          .update(`storage\n${body.content_digest}`)
          .digest("hex")}`;
        return json(200, {
          status: "stored",
          artifact: {
            artifact_ref: mintedRef,
            content_digest: body.content_digest,
            media_type: body.media_type,
            size_bytes: data.length,
            created_at: "2026-09-03T00:00:00Z",
          },
        });
      }
      if (request.method === "POST" && path === "/v1/echo") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        if (body.offer_id !== "echo.test") {
          return json(404, { refusal: { code: "not_served", message: "Offer is not served on this payable resource." } });
        }
        if (!request.headers["payment-signature"]) {
          requests.unsigned += 1;
          return json(
            402,
            { status: "error", code: "payment_required" },
            { "PAYMENT-REQUIRED": base64Header(x402Challenge(`${origin}${path}`, amount)) },
          );
        }
        requests.signed += 1;
        return json(
          200,
          { invocation_id: "inv_echo_0001", state: "completed", result: { echo: body.input } },
          { "PAYMENT-RESPONSE": base64Header(x402Settlement()) },
        );
      }
      return json(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${address(server)}`,
    requests,
    artifactRequests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
