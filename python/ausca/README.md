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
idempotency key. Each call starts with a fresh key. For recovery after an
uncertain response, pass the same caller-owned `idempotency_key`; use a new
key for another intentional purchase, even when its input is identical.

A CLI ships with the package:

```bash
ausca catalog
ausca price document.ocr
AUSCA_PRIVATE_KEY=0x... AUSCA_MAX_PAYMENT_USD=0.50 \
  ausca invoke browser.session '{"duration_seconds":600}'
# Reuse this key only to recover that same intended purchase:
ausca invoke browser.session '{"duration_seconds":600}' \
  --idempotency-key browser-attempt-20260903-0001
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
raw bytes. `ausca commit file.pdf` sends the bytes to Ausca's keyless
temporary ingress and returns the commitment the offer input carries; the
library equivalent is `client.commit(data, media_type)`. Each call creates a
fresh temporary commitment, including when the bytes match an older upload.
Pass `idempotency_key=...` only to recover the same uncertain commit. The
active offer catalog sets the usable input limit.

Successful paid state includes `receipt_ref.public_url`, an immutable
hash-only proof of the Ausca service, public price, completion time, and
receipt digest. It contains no request or result bytes, content digests, or
access capabilities. Anyone holding the unguessable URL can read it.

A result larger than the offer's inline bound arrives as `output_artifact`
instead of `output`. `client.artifact_access(artifact_ref)` mints a 60-second
download URL for it; verify the bytes against `content_digest`. A failed
invocation carries `failure.code` and `failure.message`.

The full agent contract lives at <https://ausca.com/SKILL.md>; discover the
active offers at <https://ausca.com/catalog.json>. The npm equivalent is
[`ausca`](https://www.npmjs.com/package/ausca), which adds a local MCP
server (`npx ausca mcp`).

## License

MIT
