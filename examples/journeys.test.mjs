import assert from "node:assert/strict";
import test from "node:test";

import {
  extractAndAnalyzeDocument,
  receiveVerificationCode,
  runBrowserJourney,
  transcribeWithTimings,
} from "./journeys.mjs";

const receipt = { receipt_ref: { public_url: "https://runx.ai/r/example" } };

test("browser journey uses a bodyless ticket request and always closes", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (init.method === "POST") return Response.json({
      status: "ticket_issued",
      connection: { websocket_url: "wss://browser.ausca.com/ticket", expires_at: "2026-09-21T00:01:00Z" },
    });
    if (init.method === "DELETE") return Response.json({ status: "closed", session: {} });
    return Response.json({ status: "ok", session: { state: "ready" } });
  };
  const result = await runBrowserJourney({
    client: {}, fetchImpl,
    purchaseKey: "browser-purchase-0001", connectionKey: "browser-connect-0001",
    purchaseImpl: async () => ({
      pending: false, invocationId: "inv-browser", invocation: receipt,
      resourceAccess: { kind: "browser_session", session_id: "brs_example", capability: "secret" },
    }),
    connect: async (url) => { assert.match(url, /^wss:\/\/browser\.ausca\.com\//u); return "Example Domain"; },
  });
  assert.equal(result.result, "Example Domain");
  assert.equal(requests[1].init.body, undefined);
  assert.equal(requests.at(-1).init.method, "DELETE");
  assert.equal(requests.every(({ init }) => new Headers(init.headers).get("authorization") === "Bearer secret"), true);
});

test("inbox journey waits, reads untrusted mail, returns a code, and deletes", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    if (init.method === "DELETE") return Response.json({ status: "deleted", inbox: {} });
    if (path.endsWith("/messages/msg_example")) {
      return Response.json({ status: "ok", message: { text: "Your code is 728194" } });
    }
    if (path.endsWith("/messages")) {
      return Response.json({ status: "ok", messages: [{ message_id: "msg_example" }], cursor: "cur_example" });
    }
    return Response.json({ status: "ok", inbox: { state: "active", address: "inbox+example@mail.ausca.com" } });
  };
  let requestedAddress;
  const result = await receiveVerificationCode({
    client: {}, fetchImpl, purchaseKey: "inbox-purchase-0001",
    purchaseImpl: async () => ({
      pending: false, invocationId: "inv-inbox", invocation: receipt,
      resourceAccess: { kind: "agent_inbox", inbox_id: "inb_example", capability: "secret" },
    }),
    requestMail: async (address) => { requestedAddress = address; },
    extractCode: (message) => message.text.match(/\b\d{6}\b/u)?.[0],
  });
  assert.equal(requestedAddress, "inbox+example@mail.ausca.com");
  assert.equal(result.code, "728194");
  assert.equal(requests.at(-1).init.method, "DELETE");
});

test("document journey commits once and preserves the same artifact across two purchases", async () => {
  const calls = [];
  const commitment = { artifactRef: "runx:artifact:sha256:example", contentDigest: "sha256:bytes", mediaType: "application/pdf" };
  const result = await extractAndAnalyzeDocument({
    client: { commit: async () => commitment }, bytes: new Uint8Array([1]), mediaType: "application/pdf",
    artifactKey: "document-upload-0001", ocrPurchaseKey: "document-ocr-0001",
    analysisPurchaseKey: "document-analysis-0001",
    purchaseImpl: async (_client, offer, input, key) => { calls.push({ offer, input, key }); return { offer }; },
  });
  assert.equal(result.commitment, commitment);
  assert.deepEqual(calls.map(({ offer }) => offer), ["document.ocr", "document.analysis"]);
  assert.deepEqual(calls[0].input.artifact, calls[1].input.artifact);
});

test("transcription journey returns provider-timed segments", async () => {
  const result = await transcribeWithTimings({
    client: { commit: async () => ({ artifactRef: "runx:artifact:sha256:audio", contentDigest: "sha256:audio", mediaType: "audio/mpeg" }) },
    bytes: new Uint8Array([1]), mediaType: "audio/mpeg", mediaFormat: "mp3", languageCode: "en-AU",
    artifactKey: "audio-upload-0001", purchaseKey: "audio-purchase-0001",
    purchaseImpl: async () => ({
      pending: false, invocationId: "inv-audio",
      invocation: { ...receipt, output: { text: "Hello", segments: [{ start_seconds: 0.2, end_seconds: 0.8, text: "Hello" }] } },
    }),
  });
  assert.equal(result.text, "Hello");
  assert.deepEqual(result.segments, [{ start_seconds: 0.2, end_seconds: 0.8, text: "Hello" }]);
});
