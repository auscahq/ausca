# ausca

Client for [Ausca](https://ausca.com) metered agent infrastructure services:
document OCR, document analysis, media transcription, browser sessions, and
agent inboxes. Paid per call under a hard USD cap you set, with no account
or provider API keys, and a settlement receipt on every completed
invocation.

## Install

```bash
pip install ausca
```

## Use

```python
import os
from ausca import AuscaClient

client = AuscaClient.with_local_key(
    private_key=os.environ["AUSCA_PRIVATE_KEY"],  # pays USDC on Base
    max_payment_usd=0.50,                         # hard per-call cap
)

outcome = client.invoke("browser.session", {"duration_seconds": 600})
print(outcome.result)
print(outcome.payment.transaction)  # settlement proof
```

`invoke` resolves the offer's immutable revision, schema digests, and
payable route from the live catalog, reads the exact payment requirement,
pays it if it fits the cap, and retries the same bytes with the same
idempotency key. The default idempotency key derives from the offer and
input, so an uncertain retry can never mint a second purchase.

A CLI ships with the package:

```bash
ausca catalog
ausca price document.ocr
AUSCA_PRIVATE_KEY=0x... AUSCA_MAX_PAYMENT_USD=0.50 \
  ausca invoke browser.session '{"duration_seconds":600}'
```

## Payment rails

Payment is a pluggable authority, never a client concern. The built-in
`LocalKeyAuthority` pays x402 v2 with a local signing key through the
official [`x402`](https://pypi.org/project/x402/) library, which enforces
the cap through its spend controls before anything is signed; other rails
implement the same small `PaymentAuthority` protocol.
`client.pay_request(url, ...)` runs one paid call against any resource the
configured authority can pay; nothing in it is vendor-specific.

## Artifact-backed offers

Document and media offers take an immutable artifact commitment instead of
raw bytes. With a Runx token, `RunxArtifactStore(token=...)` (or
`RUNX_API_TOKEN=... ausca commit file.pdf`) commits bytes and returns the
commitment the offer input carries.

The full agent contract lives at <https://ausca.com/SKILL.md>; discover the
active offers at <https://ausca.com/catalog.json>. The npm equivalent is
[`ausca`](https://www.npmjs.com/package/ausca), which adds a local MCP
server (`npx ausca mcp`).

## License

MIT
