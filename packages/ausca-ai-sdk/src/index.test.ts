import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { startX402Resource } from "@ausca-internal/payable-core/testkit";
import { x402Tool } from "./index.js";

const account = privateKeyToAccount(`0x${"7".repeat(64)}`);

describe("x402Tool", () => {
  it("pays a 402 within the cap and returns the result with its settlement proof", async () => {
    const resource = await startX402Resource({ amountAtomic: "50000" });
    try {
      const tool = x402Tool({
        description: "Calls the test payable resource.",
        inputSchema: z.object({ text: z.string() }),
        url: resource.url,
        account,
        maxPaymentUsd: 0.25,
      });
      const outcome = (await tool.execute!({ text: "hello" }, {
        toolCallId: "call-1",
        messages: [],
      })) as { result: { ok: boolean; echo: { text: string } }; payment: { success: boolean } };
      expect(outcome.result.ok).toBe(true);
      expect(outcome.result.echo.text).toBe("hello");
      expect(outcome.payment.success).toBe(true);
      expect(resource.requests).toEqual({ unsigned: 1, signed: 1 });
    } finally {
      await resource.close();
    }
  });

  it("refuses to pay above the declared cap before signing anything", async () => {
    const resource = await startX402Resource({ amountAtomic: "5000000" });
    try {
      const tool = x402Tool({
        description: "Calls the test payable resource.",
        inputSchema: z.object({ text: z.string() }),
        url: resource.url,
        account,
        maxPaymentUsd: 0.25,
      });
      await expect(
        tool.execute!({ text: "hello" }, { toolCallId: "call-1", messages: [] }),
      ).rejects.toThrow();
      expect(resource.requests.signed).toBe(0);
    } finally {
      await resource.close();
    }
  });
});
