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
  it("lists the catalog and reads a price without a wallet", async () => {
    const service = await startAuscaService();
    try {
      const environment = testEnvironment({ AUSCA_ORIGIN: service.origin });
      expect(await runCli(["catalog"], environment)).toBe(0);
      const listing = JSON.parse(environment.lines[0]) as { offer_id: string }[];
      expect(listing).toHaveLength(1);
      expect(listing[0].offer_id).toBe("echo.test");

      expect(await runCli(["price", "echo.test"], environment)).toBe(0);
      const price = JSON.parse(environment.lines[1]) as { currency: string };
      expect(price.currency).toBe("USD");
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

  it("commits a local file without wallet configuration", async () => {
    const service = await startAuscaService();
    const directory = await mkdtemp(join(tmpdir(), "ausca-cli-"));
    const file = join(directory, "scan.pdf");
    await writeFile(file, "pdf");
    try {
      const environment = testEnvironment({ AUSCA_ORIGIN: service.origin });
      const code = await runCli(["commit", file], environment);
      expect(environment.errors).toEqual([]);
      expect(code).toBe(0);
      const commitment = JSON.parse(environment.lines[0]) as { artifactRef: string };
      expect(commitment.artifactRef).toMatch(/^runx:artifact:sha256:/u);
      expect(service.artifactRequests).toHaveLength(1);
      expect(service.artifactRequests[0].authorization).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
      await service.close();
    }
  });
});
