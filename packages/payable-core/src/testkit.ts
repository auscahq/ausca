import { createServer, type Server } from "node:http";

// A minimal in-process x402 v2 resource for the package test suites: answers
// unsigned requests with a valid exact-scheme challenge and signed retries
// with a result plus a settlement proof. No chain is involved; the scheme
// client signs offline and this server only checks the header is present.

const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export interface TestResourceOptions {
  /** Price in atomic USDC units (6 decimals). */
  readonly amountAtomic: string;
}

export interface TestResource {
  readonly url: string;
  readonly requests: { signed: number; unsigned: number };
  close(): Promise<void>;
}

export async function startX402Resource(options: TestResourceOptions): Promise<TestResource> {
  const requests = { signed: 0, unsigned: 0 };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const url = `http://127.0.0.1:${address(server)}${request.url ?? "/"}`;
      if (!request.headers["payment-signature"]) {
        requests.unsigned += 1;
        const challenge = {
          x402Version: 2,
          error: "PAYMENT-SIGNATURE header is required",
          resource: {
            url,
            description: "Test payable resource",
            mimeType: "application/json",
            serviceName: "Testkit",
            tags: ["test"],
          },
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              asset: BASE_USDC,
              amount: options.amountAtomic,
              payTo: "0x1111111111111111111111111111111111111111",
              maxTimeoutSeconds: 60,
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        };
        response.writeHead(402, {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challenge)).toString("base64"),
        });
        response.end(JSON.stringify({ status: "error", code: "payment_required" }));
        return;
      }
      requests.signed += 1;
      const settle = {
        success: true,
        network: "eip155:8453",
        transaction: `0x${"ab".repeat(32)}`,
        payer: "0x2222222222222222222222222222222222222222",
      };
      response.writeHead(200, {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settle)).toString("base64"),
      });
      response.end(JSON.stringify({ ok: true, echo: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${address(server)}/paid`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function address(server: Server): number {
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("test server is not bound");
  }
  return bound.port;
}
