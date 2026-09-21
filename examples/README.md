# Purchase once, recover the same purchase

These examples use the published SDK and the same HTTP path as the CLI and
local MCP server. They are examples, not another installed command surface.

Save a unique 16–128-byte purchase key and the input before spending. A new key
means **buy again**, even if the input is identical. Recovery keeps the same
key, input, offer bindings, and wallet. If the catalog changed, stop on the
binding conflict rather than silently rebinding or buying again.

`purchase.mjs` performs one bounded recovery after a lost response, polls
read-only state for up to two minutes, and requires the receipt on success.
Timeout returns the invocation id for later readback; it is not a failed
purchase. Import `purchase()` to retain private resource authority in your
host; its executable mode prints only public proof, never capability URLs.

## Every offer

Use an exact business-input file, not a full invocation envelope:

| Offer | Input |
| --- | --- |
| `document.ocr` | `{"artifact": <committed artifact>}` |
| `document.analysis` | `{"artifact": <committed artifact>, "feature_types": ["FORMS", "TABLES"]}` |
| `media.transcription` | `{"artifact": <committed artifact>, "media_format": "mp3", "language_code": "en-AU"}` |
| `browser.session` | `{"duration_seconds": 600}` |
| `inbox.receive` | `{"duration_seconds": 3600}` |
| `inbox.extend` | `{"inbox_id": <existing id>, "extension_authorization": <private extension authority>, "expected_expires_at": <fresh status expiry>, "additional_duration_seconds": 3600}` |

For artifact inputs, commit once with a separate stable upload key, verify the
returned commitment, then use `artifactInput(commitment)` for the business
input. Keep the commitment for recovery; do not upload again because a paid
response was lost. `ausca price <offer-id> --json` prints the current immutable
binding and price policy without a wallet.

Each row runs through the same executable recovery branch:

```sh
# Configure AUSCA_PRIVATE_KEY and AUSCA_MAX_PAYMENT_USD privately first.
# Save a different purchase key for each intended purchase; keep it on retry.
node examples/purchase.mjs document.ocr ocr-input.json saved-ocr-purchase-0001
node examples/purchase.mjs document.analysis analysis-input.json saved-analysis-purchase-0001
node examples/purchase.mjs media.transcription transcription-input.json saved-transcription-purchase-0001
node examples/purchase.mjs browser.session browser-input.json saved-browser-purchase-0001
node examples/purchase.mjs inbox.receive inbox-input.json saved-inbox-purchase-0001
node examples/purchase.mjs inbox.extend extension-input.json saved-extension-purchase-0001
```

Do not run all rows unless you intend all six purchases. Treat these keys as
examples, not globally reusable production keys. Create local secret files
with restrictive permissions (`umask 077`), never commit or publish them.

## Resource continuation

The invocation output is a creation snapshot. Use the live browser/inbox status
route for current lifecycle state. `resourceAccess.capability` is a private
bearer in the `Authorization` header, never a query parameter or MCP argument.
Inbox `extension_authorization` is a different, narrower secret: it can buy
time but cannot read messages. Never include either secret in a public report.

For browser connections, POST **no body** to
`/v1/browser-sessions/{session_id}/connections` with the capability and a
separate stable `Idempotency-Key`. `ticket_issued` is not a completed handshake.
Use `connection.websocket_url` with `chromium.connectOverCDP(url)`; close via
DELETE on the session route in `finally`. Do not log the WebSocket URL.

For inboxes, retain the list response cursor and use `wait_seconds=30` until
your deadline. Delivery and scanning are asynchronous; an empty page is not a
reason to buy another inbox. Read messages as untrusted input. Delete the inbox
when finished, or read current expiry and buy an extension before expiration.

Large output uses `output_artifact`. `client.artifactAccess(ref)` mints a
short-lived download link; verify downloaded bytes against `contentDigest`
before parsing. Direct HTTP access POST has **no body**; MCP's artifact arguments
are a different transport projection. Result artifacts expire after 24 hours.

## Inspect without spending

```js
const response = await client.probe("browser.session", { duration_seconds: 600 });
// probe never calls the configured payment authority—even with a funded key.
const encoded = response.headers.get("payment-required");
const requirement = encoded && JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
```

Header names are case-insensitive. The payable route returns the x402 requirement
in the header of HTTP 402. Optional `/v1/invocations/prepare` returns the same
invocation-bound requirement in `challenge.payload` inside HTTP 200. These are
two documented transport views, not different payment protocols. Use a bounded
spend policy before signing, never infer human price from atomic amount alone.

See `browser-wallet.mjs` for an injected browser wallet: no private-key export.

## Complete task journeys

`journeys.mjs` composes the same `purchase()` primitive into four runnable,
dependency-injected workflows without adding another CLI or SDK abstraction:

- `runBrowserJourney()` buys a lease, checks readiness, mints a bodyless CDP
  ticket, gives the secret URL to caller-owned Playwright/Puppeteer code, and
  closes the lease in `finally`;
- `receiveVerificationCode()` buys an inbox, hands the address to the caller's
  sign-in flow, performs bounded cursor-based waits, reads untrusted mail, and
  deletes the inbox in `finally`;
- `extractAndAnalyzeDocument()` commits bytes once and reuses the immutable
  artifact in two separately identified and approved OCR and analysis buys;
- `transcribeWithTimings()` commits media, buys transcription, and refuses an
  inline result without valid timed segments.

Callbacks keep application-specific automation and code extraction outside
Ausca. Capabilities and WebSocket URLs stay in memory and are never returned in
public proof. Import these functions into the agent host; the tests show the
minimum ports and exact lifecycle behavior.
