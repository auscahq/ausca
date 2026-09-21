# ausca

<!-- mcp-name: com.ausca/agent-services -->

Metered agent infrastructure services from [Ausca](https://ausca.com):
document OCR, document analysis, media transcription, browser sessions, and
agent inboxes. Paid per call under a hard USD cap you set, with a settlement
receipt on every completed invocation. No account, no provider API keys.

One package, three doors.

## Library

```bash
npm install ausca viem
```

```ts
import { AuscaClient } from "ausca";

const client = AuscaClient.withLocalKey({
  privateKey: process.env.AUSCA_PRIVATE_KEY, // pays USDC on Base
  maxPaymentUsd: 0.5,                        // hard per-call cap
});

const outcome = await client.invoke("browser.session", { duration_seconds: 600 }, {
  idempotencyKey: savedPurchaseKey, // persist a unique key before paying
});
// Keep outcome.result.resource_access private; it contains a bearer capability.
```

`invoke` resolves the offer's immutable revision, schema digests, and payable
route from the live catalog, reads the exact payment requirement, pays it if
it fits the cap, and retries the same bytes with the same idempotency key.
Each call starts with a fresh key. For recovery after an uncertain response,
pass the same caller-owned `idempotencyKey`; use a new key for another
intentional purchase, even when its input is identical.

## CLI

```bash
npx ausca catalog
npx ausca price document.ocr
AUSCA_PRIVATE_KEY=0x... AUSCA_MAX_PAYMENT_USD=0.50 \
  npx ausca invoke browser.session '{"duration_seconds":600}' \
  --idempotency-key browser-attempt-20260903-0001
# Reuse this key only to recover that same intended purchase:
npx ausca invoke browser.session '{"duration_seconds":600}' \
  --idempotency-key browser-attempt-20260903-0001
```

## MCP

The local server that pays where the key lives. Tools are derived from the
live catalog at startup, one per active offer. Paid tools require
`ausca_idempotency_key`. Save a unique key before each new intended purchase
and reuse it with unchanged input for recovery. CLI `invoke` similarly requires
`--idempotency-key` and accepts inline JSON, a bare file path, `@file`, or stdin.
`price --json` includes immutable revision/schema/pricing digests and route.
Resource responses contain private capabilities: do not publish raw output.
See the [executable caller journeys](https://github.com/auscahq/ausca/tree/main/examples).

```json
{
  "mcpServers": {
    "ausca": {
      "command": "npx",
      "args": ["-y", "ausca", "mcp"],
      "env": {
        "AUSCA_PRIVATE_KEY": "0x...",
        "AUSCA_MAX_PAYMENT_USD": "0.50"
      }
    }
  }
}
```

## Payment rails

Payment is a pluggable authority, never a client concern. The built-in
authority pays x402 v2 with a local signing key through the official
`@x402/*` libraries; any scheme they support plugs in through
`x402Authority`, and other rails implement the same small interface. The cap
is enforced before anything is signed.

## Artifact-backed offers

Document and media offers take an immutable artifact commitment instead of
raw bytes. `npx ausca commit file.pdf` sends the bytes to Ausca's keyless
temporary ingress and returns the commitment the offer input carries; the
library equivalent is `client.commit(bytes, mediaType)`. Each call creates a
fresh temporary commitment, including when the bytes match an older upload.
Pass an explicit idempotency key only to recover the same uncertain commit.
The active offer catalog sets the usable input limit.

Successful paid state includes `receipt_ref.public_url`, an immutable
hash-only proof of the Ausca service, public price, completion time, and
receipt digest. It contains no request or result bytes, content digests, or
access capabilities. Anyone holding the unguessable URL can read it.

The full agent contract lives at <https://ausca.com/SKILL.md>; the active
offers at <https://ausca.com/catalog.json>. The engine underneath is
[@ausca/sdk](https://www.npmjs.com/package/@ausca/sdk).

## License

MIT
