---
name: browser-session
description: Lease one ordinary remote browser with standard CDP access for 10, 30, or 60 minutes through Ausca.
---

# Ausca Browser Session

Use this service when an agent already knows how to drive CDP, Playwright, or
Puppeteer and needs a short-lived remote browser without creating an account.
It is browser infrastructure, not a browser agent.

## What the purchase includes

One paid invocation creates or exactly replays one browser lease. Choose the
duration before approval; the prices are:

- 10 minutes: $0.05 USD
- 30 minutes: $0.10 USD
- 60 minutes: $0.20 USD

Preparation binds the exact duration and amount. The
result includes a session id, expiry, and an opaque bearer capability. Status,
CDP connection creation, and close do not charge again.

The service does not provide actions, extraction, crawling, recording,
persistent profiles, proxies, stealth, CAPTCHA solving, or a target-success
promise.

## Invoke

Invoke the exact `ausca/browser-session` package through the caller's skill
runtime. The runtime resolves immutable live terms and routes the paid call to
`https://ausca.com/v1/lease-browser`. The exact service input is
`{"duration_seconds":600}`, `{"duration_seconds":1800}`, or
`{"duration_seconds":3600}`. There are no other browser options.

After an authorized purchase, read `resource_result.resource_access` from the
verified paid-invocation readback. It contains the session id, expiry, and the
opaque capability. The capability is returned only by paid admission or its
exact authenticated replay; invocation status and receipts do not contain it.
Keep it in host-controlled secret state. Never place it in a prompt, log,
receipt, query string, or later model-authored tool argument. Losing it is not
recoverable through public lookup.

## Use the lease

Supply `Authorization: Bearer <capability>` from the host boundary. For direct
HTTP, attach it to the lifecycle request. For MCP, attach it to the Streamable
HTTP request carrying the tool call; it is never a tool argument or JSON field.
Keep one MCP request or connection scoped to one lease authority.

1. `GET /v1/browser-sessions/{session_id}` for status and hard expiry.
2. `POST /v1/browser-sessions/{session_id}/connections` with a stable
   `Idempotency-Key` to mint a short-lived CDP WebSocket ticket.
3. Connect to the returned `wss://browser.ausca.com/...` URL using an ordinary
   CDP client.
4. `DELETE /v1/browser-sessions/{session_id}` to close early, or allow the hard
   expiry to clean it up.

Only one CDP connection may be live at once. Connection tickets last 60 seconds,
are single-use, and stop after eight issues. Use a stable connection
`Idempotency-Key` to recover the same intended ticket; a different key means a
new ticket issue. Each CDP message is capped at 32 MiB. Status can report a
terminal lease, but connect requires `ready`. Close is idempotent, including
after terminal state.

A browser lease cannot be extended. Choose the required duration before
purchase. More browser time means a separately approved new session with new
state and authority; no cookies, storage, tabs, or profile data carry over.

Reuse the purchase idempotency identity only for the same intended lease. If the
paid response is uncertain, replay that exact purchase; never mint a second
payment identity. Changed duration or terms under an existing identity are a
conflict. Expiry, exhausted ticket issues, unavailable capacity, invalid
authority, and an unverifiable provider result or receipt are stop conditions,
not permission to bypass the lease path. A failed invocation reports
`failure.code` and `failure.message`; the payment is refunded.

Successful paid state returns `receipt_ref.public_url`, an immutable hash-only
proof of the service, public price, completion time, and receipt digest. It
contains no browser state, connection ticket, lease capability, or content
digest and is readable by anyone holding the unguessable URL, so share it
deliberately.

The active catalog revision and linked schemas are the machine authority. x402
uses its external V2 semantics; Ausca's internal contracts remain V1.
