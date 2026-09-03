# ausca

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

const outcome = await client.invoke("browser.session", { duration_seconds: 600 });
console.log(outcome.result);
console.log(outcome.payment?.transaction); // settlement proof
```

`invoke` resolves the offer's immutable revision, schema digests, and payable
route from the live catalog, reads the exact payment requirement, pays it if
it fits the cap, and retries the same bytes with the same idempotency key.
The default idempotency key derives from the offer and input, so an uncertain
retry can never mint a second purchase.

## CLI

```bash
npx ausca catalog
npx ausca price document.ocr
AUSCA_PRIVATE_KEY=0x... AUSCA_MAX_PAYMENT_USD=0.50 \
  npx ausca invoke browser.session '{"duration_seconds":600}'
```

## MCP

The local server that pays where the key lives. Tools are derived from the
live catalog at startup, one per active offer.

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
raw bytes. With a Runx token, `RUNX_API_TOKEN=... npx ausca commit file.pdf`
returns the commitment the offer input carries; the library equivalent is
`client.commit(bytes, mediaType)`.

The full agent contract lives at <https://ausca.com/SKILL.md>; the active
offers at <https://ausca.com/catalog.json>. The engine underneath is
[@ausca/sdk](https://www.npmjs.com/package/@ausca/sdk).

## License

MIT
