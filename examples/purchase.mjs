import { AuscaClient, InvocationUncertainError, RefusalError } from "@ausca/sdk";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// The caller saves input and a unique purchase key BEFORE this function runs.
// No hidden local wallet, retry database, or content-based purchase deduplication.
export async function purchase(client, offerId, input, key, { timeoutMs = 120_000, pause = delay } = {}) {
  const invoke = () => client.invoke(offerId, input, { idempotencyKey: key });
  let admission;
  try {
    admission = await invoke();
  } catch (error) {
    if (!(error instanceof InvocationUncertainError)
      && !(error instanceof RefusalError && error.status >= 500)) throw error;
    // One bounded recovery attempt, with the same identity, input and wallet.
    // Runx authenticates replay and returns the original settlement, not a new one.
    admission = await invoke();
  }
  const invocationId = admission.result.invocation?.invocation_id;
  if (!invocationId) throw new Error("Admission has no invocation identity; retain the purchase key and stop.");
  let state = admission.result.invocation;
  const deadline = Date.now() + timeoutMs;
  while (!["succeeded", "failed", "cancelled"].includes(state.state)) {
    if (Date.now() >= deadline) return { pending: true, invocationId, identity: admission.identity };
    await pause(2_000);
    state = (await client.invocation(invocationId)).invocation;
  }
  if (state.state !== "succeeded") throw new Error(`Invocation ${invocationId} ended ${state.state}; inspect failure and refund state, do not buy again automatically.`);
  if (!state.receipt_ref?.public_url) throw new Error("Successful state has no public receipt; retain the purchase identity and stop.");
  // Capabilities are deliberately absent from public polling. An authenticated
  // replay claims the original resource without allocating or charging again.
  if (["browser.session", "inbox.receive"].includes(offerId) && !admission.result.resource_access) {
    admission = await invoke();
    if (!admission.result.resource_access) throw new Error("Resource authority is unavailable; retain the same purchase identity.");
  }
  return { pending: false, invocationId, identity: admission.identity, invocation: state, resourceAccess: admission.result.resource_access };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [offerId, inputPath, key] = process.argv.slice(2);
  if (!offerId || !inputPath || !key) throw new Error("usage: node examples/purchase.mjs <offer-id> <input.json> <saved-purchase-key>");
  const client = AuscaClient.withLocalKey({
    privateKey: process.env.AUSCA_PRIVATE_KEY,
    maxPaymentUsd: Number(process.env.AUSCA_MAX_PAYMENT_USD),
  });
  const result = await purchase(client, offerId, JSON.parse(await readFile(inputPath, "utf8")), key);
  // Resource authority must remain private. The executable prints proof only;
  // import purchase() into your host to retain and use resourceAccess securely.
  console.log(JSON.stringify({
    pending: result.pending, invocation_id: result.invocationId,
    identity: result.identity, receipt_url: result.invocation?.receipt_ref?.public_url,
  }));
}
