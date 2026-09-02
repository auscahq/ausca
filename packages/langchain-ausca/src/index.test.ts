import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { startX402Resource } from "@ausca-internal/payable-core/testkit";
import { payableTool } from "./index.js";

const account = privateKeyToAccount(`0x${"7".repeat(64)}`);

describe("payableTool", () => {
  it("pays a 402 within the cap and returns the result with its settlement proof", async () => {
    const resource = await startX402Resource({ amountAtomic: "50000" });
    try {
      const payments: unknown[] = [];
      const tool = payableTool({
        name: "test_paid_call",
        description: "Calls the test payable resource.",
        schema: z.object({ text: z.string() }),
        url: resource.url,
        account,
        maxPaymentUsd: 0.25,
        onPayment: (payment) => payments.push(payment),
      });
      const raw = await tool.invoke({ text: "hello" });
      const outcome = JSON.parse(raw as string);
      expect(outcome.result.ok).toBe(true);
      expect(outcome.result.echo.text).toBe("hello");
      expect(outcome.payment.success).toBe(true);
      expect(outcome.payment.transaction).toMatch(/^0x/);
      expect(payments).toHaveLength(1);
      expect(resource.requests).toEqual({ unsigned: 1, signed: 1 });
    } finally {
      await resource.close();
    }
  });

  it("refuses to pay above the declared cap before signing anything", async () => {
    const resource = await startX402Resource({ amountAtomic: "5000000" });
    try {
      const tool = payableTool({
        name: "test_capped_call",
        description: "Calls the test payable resource.",
        schema: z.object({ text: z.string() }),
        url: resource.url,
        account,
        maxPaymentUsd: 0.25,
      });
      await expect(tool.invoke({ text: "hello" })).rejects.toThrow();
      expect(resource.requests.signed).toBe(0);
    } finally {
      await resource.close();
    }
  });
});
