import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startAuscaService } from "@ausca/sdk/testkit";

import { runCli, mediaTypeFor, type CliEnvironment } from "./cli.js";

const TEST_KEY = `0x${"7".repeat(64)}`;

function testEnvironment(env: Record<string, string>): CliEnvironment & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    env,
    lines,
    errors,
    write: (line) => lines.push(line),
    writeError: (line) => errors.push(line),
    readStdin: async () => "",
  };
}

describe("ausca cli", () => {
  it("requires a saved purchase identity before any payable request", async () => {
    const service = await startAuscaService();
    try {
      const environment = testEnvironment({
        AUSCA_ORIGIN: service.origin, AUSCA_PRIVATE_KEY: TEST_KEY, AUSCA_MAX_PAYMENT_USD: "0.05",
      });
      expect(await runCli(["invoke", "echo.test", "{}"], environment)).toBe(1);
      expect(environment.errors[0]).toContain("--idempotency-key");
      expect(service.requests).toEqual({ unsigned: 0, signed: 0 });
    } finally { await service.close(); }
  });
  it("lists the catalog and reads a price without a wallet", async () => {
    const service = await startAuscaService();
    try {
      const environment = testEnvironment({ AUSCA_ORIGIN: service.origin });
      expect(await runCli(["catalog"], environment)).toBe(0);
      const listing = JSON.parse(environment.lines[0]) as { offer_id: string }[];
      expect(listing).toHaveLength(1);
      expect(listing[0].offer_id).toBe("echo.test");

      expect(await runCli(["price", "echo.test", "--json"], environment)).toBe(0);
      expect(JSON.parse(environment.lines[1])).toMatchObject({
        currency: "USD",
        offer_revision_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        pricing_policy_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        input_schema_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        output_schema_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        route: { method: "POST", path: "/v1/echo" },
      });
    } finally {
      await service.close();
    }
  });

  it("pays an invocation from inline JSON input", async () => {
    const service = await startAuscaService();
    try {
      const environment = testEnvironment({
        AUSCA_ORIGIN: service.origin,
        AUSCA_PRIVATE_KEY: TEST_KEY,
        AUSCA_MAX_PAYMENT_USD: "0.05",
      });
      const code = await runCli([
        "invoke",
        "echo.test",
        '{"message":"hi"}',
        "--idempotency-key",
        "cli-purchase-20260903-0001",
      ], environment);
      expect(environment.errors).toEqual([]);
      expect(code).toBe(0);
      const outcome = JSON.parse(environment.lines[0]) as {
        payment: { success: boolean };
        result: { result: { echo: { message: string } } };
      };
      expect(outcome.payment.success).toBe(true);
      expect(outcome.result.result.echo.message).toBe("hi");
      expect(service.requests).toEqual({ unsigned: 1, signed: 1 });
    } finally {
      await service.close();
    }
  });

  it("refuses paid verbs without a key and refuses a key without a cap", async () => {
    const service = await startAuscaService();
    try {
      const noKey = testEnvironment({ AUSCA_ORIGIN: service.origin });
      expect(await runCli(["invoke", "echo.test", "{}"], noKey)).toBe(1);
      expect(noKey.errors[0]).toContain("AUSCA_PRIVATE_KEY");

      const noCap = testEnvironment({
        AUSCA_ORIGIN: service.origin,
        AUSCA_PRIVATE_KEY: TEST_KEY,
      });
      expect(await runCli(["invoke", "echo.test", "{}"], noCap)).toBe(1);
      expect(noCap.errors[0]).toContain("refusing to guess a spend limit");
      expect(service.requests.signed).toBe(0);
    } finally {
      await service.close();
    }
  });

  it("maps media types by extension with an honest fallback", () => {
    expect(mediaTypeFor("contract.pdf")).toBe("application/pdf");
    expect(mediaTypeFor("call.MP3")).toBe("audio/mpeg");
    expect(mediaTypeFor("mystery.bin")).toBe("application/octet-stream");
  });

  it("accepts a bare input file path and retains the caller's purchase key", async () => {
    const service = await startAuscaService();
    const directory = await mkdtemp(join(tmpdir(), "ausca-cli-input-"));
    const file = join(directory, "input.json");
    await writeFile(file, JSON.stringify({ message: "from file" }));
    try {
      const environment = testEnvironment({
        AUSCA_ORIGIN: service.origin, AUSCA_PRIVATE_KEY: TEST_KEY, AUSCA_MAX_PAYMENT_USD: "0.05",
      });
      const key = "cli-file-purchase-0001";
      expect(await runCli(["invoke", "echo.test", file, "--idempotency-key", key], environment)).toBe(0);
      expect(environment.errors).toEqual([]);
      expect(JSON.parse(environment.lines[0])).toMatchObject({
        identity: { offerId: "echo.test", idempotencyKey: key },
        result: { result: { echo: { message: "from file" } } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await service.close();
    }
  });

  it("commits a local file without wallet configuration", async () => {
    const service = await startAuscaService();
    const directory = await mkdtemp(join(tmpdir(), "ausca-cli-"));
    const file = join(directory, "scan.pdf");
    await writeFile(file, "pdf");
    try {
      const environment = testEnvironment({ AUSCA_ORIGIN: service.origin });
      const code = await runCli([
        "commit",
        file,
        "--idempotency-key",
        "cli-artifact-20260915-0001",
      ], environment);
      expect(environment.errors).toEqual([]);
      expect(code).toBe(0);
      const commitment = JSON.parse(environment.lines[0]) as { artifactRef: string };
      expect(commitment.artifactRef).toBeTypeOf("string");
      expect(commitment.artifactRef).not.toBe("");
      expect(service.artifactRequests).toHaveLength(1);
      expect(service.artifactRequests[0].authorization).toBeUndefined();
      expect(service.artifactRequests[0].body.idempotency_key)
        .toBe("cli-artifact-20260915-0001");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await service.close();
    }
  });
});
