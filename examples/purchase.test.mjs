import assert from "node:assert/strict";
import test from "node:test";
import { InvocationUncertainError } from "@ausca/sdk";
import { purchase } from "./purchase.mjs";

for (const offerId of ["document.ocr", "document.analysis", "media.transcription", "browser.session", "inbox.receive", "inbox.extend"]) {
  test(`${offerId}: uncertain admission recovers the same purchase and waits for receipt`, async () => {
    const calls = [];
    const key = "example-purchase-key-0001";
    const input = { fixture: "unchanged intent" };
    const identity = { offerId, idempotencyKey: key };
    const ready = { invocation_id: "inv-example", state: "succeeded", receipt_ref: { public_url: "https://runx.ai/r/fixture" } };
    const resourceAccess = { capability: "private-fixture-authority" };
    const client = {
      async invoke(id, value, options) {
        calls.push({ id, value, options });
        if (calls.length === 1) throw new InvocationUncertainError(identity);
        return { identity, result: { invocation: { invocation_id: "inv-example", state: "running" }, ...(calls.length > 2 && { resource_access: resourceAccess }) } };
      },
      async invocation(id) { assert.equal(id, "inv-example"); return { invocation: ready }; },
    };
    const result = await purchase(client, offerId, input, key, { pause: async () => {} });
    assert.equal(result.invocation, ready);
    assert.equal(calls.length, ["browser.session", "inbox.receive"].includes(offerId) ? 3 : 2);
    for (const call of calls) assert.deepEqual(call, { id: offerId, value: input, options: { idempotencyKey: key } });
    assert.equal(result.identity, identity);
  });
}

test("poll timeout returns recovery identity, not a replacement purchase", async () => {
  let calls = 0;
  const identity = { offerId: "document.analysis", idempotencyKey: "example-pending-key-0001" };
  const result = await purchase({ async invoke() { calls++; return { identity, result: { invocation: { invocation_id: "inv-pending", state: "running" } } }; } }, identity.offerId, {}, identity.idempotencyKey, { timeoutMs: 0 });
  assert.equal(result.pending, true);
  assert.equal(result.invocationId, "inv-pending");
  assert.equal(calls, 1);
});

test("terminal success without a receipt is not accepted", async () => {
  await assert.rejects(purchase({ async invoke() { return { result: { invocation: { invocation_id: "inv-missing-proof", state: "succeeded" } } }; } }, "document.ocr", {}, "example-missing-proof-0001"), /no public receipt/u);
});
