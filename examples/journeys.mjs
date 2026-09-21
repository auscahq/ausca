import { artifactInput } from "@ausca/sdk";
import { purchase } from "./purchase.mjs";

const DEFAULT_ORIGIN = "https://ausca.com";

/**
 * Buy one browser lease, mint one CDP ticket, run caller-owned automation, and
 * close the lease. The callback receives the secret WebSocket URL in memory;
 * this function never returns or logs it.
 */
export async function runBrowserJourney({
  client,
  connect,
  purchaseKey,
  connectionKey,
  durationSeconds = 600,
  fetchImpl = globalThis.fetch,
  origin = DEFAULT_ORIGIN,
  purchaseImpl = purchase,
}) {
  requireFunction(connect, "connect");
  const bought = await purchaseImpl(
    client,
    "browser.session",
    { duration_seconds: durationSeconds },
    purchaseKey,
  );
  if (bought.pending) return bought;
  const access = resourceAccess(bought, "browser_session");
  const path = `/v1/browser-sessions/${encodeURIComponent(access.session_id)}`;
  try {
    const status = await authorizedJson(fetchImpl, `${origin}${path}`, access.capability);
    if (status.session?.state !== "ready") {
      throw new Error(`Browser session is ${status.session?.state ?? "invalid"}; do not mint a connection.`);
    }
    const ticket = await authorizedJson(
      fetchImpl,
      `${origin}${path}/connections`,
      access.capability,
      { method: "POST", headers: { "Idempotency-Key": cleanKey(connectionKey) } },
    );
    const websocketUrl = ticket.connection?.websocket_url;
    if (ticket.status !== "ticket_issued" || typeof websocketUrl !== "string"
      || !websocketUrl.startsWith("wss://browser.ausca.com/")) {
      throw new Error("Browser connection response is invalid.");
    }
    const result = await connect(websocketUrl);
    return {
      pending: false,
      invocationId: bought.invocationId,
      receiptUrl: bought.invocation.receipt_ref.public_url,
      result,
    };
  } finally {
    await authorizedJson(fetchImpl, `${origin}${path}`, access.capability, { method: "DELETE" });
  }
}

/**
 * Buy one receive-only inbox, hand its address to the caller's sign-in flow,
 * wait for mail, read messages as untrusted input, and return the first code
 * accepted by extractCode. The inbox is deleted in finally by default.
 */
export async function receiveVerificationCode({
  client,
  requestMail,
  extractCode,
  purchaseKey,
  durationSeconds = 3600,
  timeoutMs = 120_000,
  waitSeconds = 30,
  cleanup = true,
  fetchImpl = globalThis.fetch,
  origin = DEFAULT_ORIGIN,
  purchaseImpl = purchase,
  now = Date.now,
}) {
  requireFunction(requestMail, "requestMail");
  requireFunction(extractCode, "extractCode");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer.");
  }
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 30) {
    throw new TypeError("waitSeconds must be an integer from 1 to 30.");
  }
  const bought = await purchaseImpl(
    client,
    "inbox.receive",
    { duration_seconds: durationSeconds },
    purchaseKey,
  );
  if (bought.pending) return bought;
  const access = resourceAccess(bought, "agent_inbox");
  const path = `/v1/agent-inboxes/${encodeURIComponent(access.inbox_id)}`;
  try {
    const status = await authorizedJson(fetchImpl, `${origin}${path}`, access.capability);
    const address = status.inbox?.address;
    if (status.inbox?.state !== "active" || typeof address !== "string") {
      throw new Error("Inbox is not active after purchase.");
    }
    await requestMail(address);
    const deadline = now() + timeoutMs;
    let cursor;
    while (now() < deadline) {
      const query = new URLSearchParams({ wait_seconds: String(waitSeconds) });
      if (cursor) query.set("after", cursor);
      const page = await authorizedJson(
        fetchImpl,
        `${origin}${path}/messages?${query}`,
        access.capability,
      );
      if (!Array.isArray(page.messages) || typeof page.cursor !== "string") {
        throw new Error("Inbox message page is invalid.");
      }
      for (const summary of page.messages) {
        const message = await authorizedJson(
          fetchImpl,
          `${origin}${path}/messages/${encodeURIComponent(summary.message_id)}`,
          access.capability,
        );
        const code = await extractCode(message.message);
        if (code !== undefined && code !== null) {
          return {
            pending: false,
            address,
            code,
            messageId: summary.message_id,
            invocationId: bought.invocationId,
            receiptUrl: bought.invocation.receipt_ref.public_url,
          };
        }
      }
      cursor = page.cursor;
    }
    throw new Error("No matching verification message arrived before the caller deadline.");
  } finally {
    if (cleanup) {
      await authorizedJson(fetchImpl, `${origin}${path}`, access.capability, { method: "DELETE" });
    }
  }
}

/** Commit one document once, then make two separately authorized purchases. */
export async function extractAndAnalyzeDocument({
  client,
  bytes,
  mediaType,
  artifactKey,
  ocrPurchaseKey,
  analysisPurchaseKey,
  featureTypes = ["FORMS", "TABLES"],
  purchaseImpl = purchase,
}) {
  const commitment = await client.commit(bytes, mediaType, { idempotencyKey: artifactKey });
  const artifact = artifactInput(commitment);
  const ocr = await purchaseImpl(client, "document.ocr", { artifact }, ocrPurchaseKey);
  const analysis = await purchaseImpl(
    client,
    "document.analysis",
    { artifact, feature_types: featureTypes },
    analysisPurchaseKey,
  );
  return { commitment, ocr, analysis };
}

/** Commit media, buy transcription, and require timed inline segments. */
export async function transcribeWithTimings({
  client,
  bytes,
  mediaType,
  mediaFormat,
  languageCode,
  artifactKey,
  purchaseKey,
  purchaseImpl = purchase,
}) {
  const commitment = await client.commit(bytes, mediaType, { idempotencyKey: artifactKey });
  const bought = await purchaseImpl(client, "media.transcription", {
    artifact: artifactInput(commitment),
    media_format: mediaFormat,
    language_code: languageCode,
  }, purchaseKey);
  if (bought.pending) return bought;
  const output = bought.invocation.output;
  if (!output || !Array.isArray(output.segments)
    || output.segments.some((segment) => !Number.isFinite(segment.start_seconds)
      || !Number.isFinite(segment.end_seconds) || typeof segment.text !== "string")) {
    throw new Error("Transcription did not return valid timed inline segments; inspect output_artifact before retrying the purchase.");
  }
  return {
    pending: false,
    invocationId: bought.invocationId,
    receiptUrl: bought.invocation.receipt_ref.public_url,
    text: output.text,
    segments: output.segments,
  };
}

async function authorizedJson(fetchImpl, url, capability, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${capability}`);
  const response = await fetchImpl(url, { ...init, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok || body === null) {
    throw new Error(`Ausca lifecycle request answered ${response.status}.`);
  }
  return body;
}

function resourceAccess(bought, kind) {
  const access = bought.resourceAccess;
  if (!access || access.kind !== kind || typeof access.capability !== "string") {
    throw new Error(`Purchase returned no ${kind} authority; recover with the same purchase identity.`);
  }
  return access;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function.`);
}

function cleanKey(value) {
  const byteLength = typeof value === "string" ? new TextEncoder().encode(value).byteLength : 0;
  if (typeof value !== "string" || byteLength < 16 || byteLength > 128
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("connectionKey must be 16 to 128 clean UTF-8 bytes.");
  }
  return value;
}
