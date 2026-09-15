import { createServer } from "node:http";
import { createHash } from "node:crypto";

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { address } from "@ausca-internal/payable/testkit";
import { ArtifactError } from "./artifacts.js";
import { AuscaClient, OfferNotActiveError } from "./client.js";
import { inertAuthority, localKeyAuthority, type PaymentAuthority } from "./payment.js";
import { startAuscaService } from "./testkit.js";

const account = privateKeyToAccount(`0x${"7".repeat(64)}`);

describe("AuscaClient", () => {
  it("resolves catalog, offer, and price without any wallet", async () => {
    const service = await startAuscaService();
    try {
      const client = new AuscaClient({ payment: inertAuthority(), origin: service.origin });
      const offer = await client.offer("echo.test");
      expect(offer.routePath).toBe("/v1/echo");
      expect(offer.revision).toBe("echo-r1");
      expect(offer.inputSchemaPath).toBe("/schemas/offers/echo.input.schema.json");
      const price = await client.price("echo.test");
      expect(price).toMatchObject({ currency: "USD", model: "fixed", minimumMinor: 1 });
      await expect(client.offer("missing.offer")).rejects.toThrow(OfferNotActiveError);
    } finally {
      await service.close();
    }
  });

  it("pays one invocation within the cap and returns the settlement proof", async () => {
    const service = await startAuscaService({ amountAtomic: "10000" });
    try {
      const client = AuscaClient.withLocalKey({
        account,
        maxPaymentUsd: 0.05,
        origin: service.origin,
      });
      const outcome = await client.invoke("echo.test", { message: "hello" });
      expect((outcome.result as { result: { echo: { message: string } } }).result.echo.message).toBe("hello");
      expect(outcome.payment?.success).toBe(true);
      expect(service.requests).toEqual({ unsigned: 1, signed: 1 });
      const state = await client.invocation("inv_echo_0001");
      expect(state.state).toBe("completed");
    } finally {
      await service.close();
    }
  });

  it("mints artifact access for a referenced result without paying", async () => {
    const service = await startAuscaService();
    try {
      const client = new AuscaClient({ payment: inertAuthority(), origin: service.origin });
      const artifactRef = `runx:artifact:sha256:${"a".repeat(64)}`;
      const access = await client.artifactAccess(artifactRef, "ausca-access-recovery-key-1");
      expect(access).toEqual({
        artifactRef,
        contentDigest: `sha256:${"c".repeat(64)}`,
        mediaType: "application/json",
        sizeBytes: 70_000,
        createdAt: "2026-09-06T00:00:00Z",
        downloadUrl: "https://artifacts.example/o/1?sig=2",
        expiresAt: "2026-09-06T00:01:00Z",
      });
      expect(service.requests).toEqual({ unsigned: 0, signed: 0 });
    } finally {
      await service.close();
    }
  });

  it("refuses to pay above the cap before anything is signed", async () => {
    const service = await startAuscaService({ amountAtomic: "5000000" });
    try {
      const client = new AuscaClient({
        payment: localKeyAuthority({ account, maxPaymentUsd: 0.05 }),
        origin: service.origin,
      });
      await expect(client.invoke("echo.test", { message: "hello" })).rejects.toThrow();
      expect(service.requests.signed).toBe(0);
    } finally {
      await service.close();
    }
  });

  it("works through any payment authority, not only local x402 keys", async () => {
    const service = await startAuscaService();
    try {
      // A stand-in for a delegated rail: on a 402 it retries the same bytes
      // with its own credential header instead of signing locally.
      const delegated: PaymentAuthority = {
        rails: ["test-delegated"],
        wrapFetch: (base) => async (input, init) => {
          const first = await base(input, init);
          if (first.status !== 402) {
            return first;
          }
          return base(input, {
            ...init,
            headers: { ...(init?.headers as Record<string, string>), "PAYMENT-SIGNATURE": "delegated" },
          });
        },
        receipt: () => ({ success: true, transaction: "delegated", network: "test", payer: "test" }),
      };
      const client = new AuscaClient({ payment: delegated, origin: service.origin });
      const outcome = await client.invoke("echo.test", { message: "via port" });
      expect(outcome.payment?.transaction).toBe("delegated");
      expect(service.requests).toEqual({ unsigned: 1, signed: 1 });
    } finally {
      await service.close();
    }
  });

  it("starts distinct purchases by default and preserves an explicit recovery key", async () => {
    const service = await startAuscaService();
    try {
      const client = new AuscaClient({ payment: inertAuthority(), origin: service.origin });
      const offer = await client.offer("echo.test");
      const first = await client.envelope(offer, { message: "same" });
      const second = await client.envelope(offer, { message: "same" });
      const recovered = await client.envelope(
        offer,
        { message: "same" },
        "purchase-20260903-0001",
      );
      expect(first.idempotency_key).not.toBe(second.idempotency_key);
      expect(String(first.idempotency_key)).toMatch(/^ausca-[0-9a-f-]{36}$/u);
      expect(recovered.idempotency_key).toBe("purchase-20260903-0001");
      await expect(client.envelope(offer, {}, "too-short")).rejects.toThrow(
        "16 to 128 clean UTF-8 bytes",
      );
      await expect(client.envelope(offer, {}, "🙂".repeat(40))).rejects.toThrow(
        "16 to 128 clean UTF-8 bytes",
      );
      await expect(client.envelope(offer, {}, "purchase-20260903\n0001")).rejects.toThrow(
        "16 to 128 clean UTF-8 bytes",
      );
    } finally {
      await service.close();
    }
  });
});

describe("Ausca artifact ingress", () => {
  it("uses a fresh commit identity by default and preserves an explicit recovery identity", async () => {
    const operations: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        operations.push({ ...body, authorization: request.headers.authorization, path: request.url });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          status: "stored",
          artifact: {
            artifact_ref: `runx:artifact:sha256:${createHash("sha256")
              .update(`storage\n${body.content_digest}`)
              .digest("hex")}`,
            content_digest: body.content_digest,
            media_type: "application/pdf",
            size_bytes: 3,
            created_at: "2026-09-03T00:00:00Z",
          },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const client = new AuscaClient({
        payment: inertAuthority(),
        origin: `http://127.0.0.1:${address(server)}`,
      });
      const commitment = await client.commit(new TextEncoder().encode("pdf"), "application/pdf");
      await client.commit(new TextEncoder().encode("pdf"), "application/pdf");
      await client.commit(new TextEncoder().encode("pdf"), "application/pdf", {
        idempotencyKey: "artifact-recovery-20260915-0001",
      });
      const digest = createHash("sha256").update("pdf").digest("hex");
      const mintedDigest = createHash("sha256")
        .update(`storage\nsha256:${digest}`)
        .digest("hex");
      expect(commitment.artifactRef).toBe(`runx:artifact:sha256:${mintedDigest}`);
      expect(commitment.contentDigest).toBe(`sha256:${digest}`);
      expect(operations).toHaveLength(3);
      const [commit, second, recovered] = operations as Record<string, never>[];
      expect(commit.path).toBe("/v1/artifacts");
      expect(commit.authorization).toBeUndefined();
      expect(commit.idempotency_key).toMatch(/^ausca-artifact-[0-9a-f-]{36}$/u);
      expect(second.idempotency_key).toMatch(/^ausca-artifact-[0-9a-f-]{36}$/u);
      expect(second.idempotency_key).not.toBe(commit.idempotency_key);
      expect(recovered.idempotency_key).toBe("artifact-recovery-20260915-0001");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("surfaces server refusals as typed artifact errors", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Missing artifact operation scope." }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const client = new AuscaClient({
        payment: inertAuthority(),
        origin: `http://127.0.0.1:${address(server)}`,
      });
      await expect(client.commit(new TextEncoder().encode("pdf"), "application/pdf"))
        .rejects.toThrow(ArtifactError);
      await expect(client.commit(new Uint8Array(), "application/pdf"))
        .rejects.toThrow("1 to");
      await expect(client.commit(
        new TextEncoder().encode("pdf"),
        "application/pdf",
        { idempotencyKey: "too-short" },
      )).rejects.toThrow("16 to 128 clean UTF-8 bytes");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
