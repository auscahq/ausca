# ausca

Client for [Ausca](https://ausca.com) metered agent infrastructure services:
document OCR, document analysis, media transcription, browser sessions, and
agent inboxes, paid per call over x402 v2 with no account or provider API
keys, and a receipt for every completed invocation.

Payment construction and signing stay entirely in the official
[`x402`](https://pypi.org/project/x402/) library. This client binds invocation
envelopes to the immutable catalog, enforces a hard per-call USD cap through
the library's spend controls before anything is signed, and returns results
together with their decoded settlement proof.

## Install

```bash
pip install ausca
```

## Use

```python
from ausca import AuscaClient

client = AuscaClient(
    private_key=os.environ["WALLET_PRIVATE_KEY"],  # pays USDC on Base
    max_payment_usd=0.50,                          # hard per-call cap
)

outcome = client.invoke(
    "document.ocr",
    {
        "artifact": {
            "artifact_ref": "runx:artifact:sha256:...",
            "content_digest": "sha256:...",
            "media_type": "application/pdf",
        }
    },
)
print(outcome.result)
print(outcome.payment.transaction)  # settlement proof from PAYMENT-RESPONSE
```

`invoke` resolves the offer's immutable revision, schema digests, and payable
route from the live catalog, sends the unsigned envelope to read the exact
x402 v2 requirement, pays it if it fits the cap, and retries the same bytes
with the same idempotency key. The default idempotency key derives from the
offer and input, so an uncertain retry can never mint a second purchase.

The full agent contract lives at <https://ausca.com/SKILL.md>; discover the
active offers at <https://ausca.com/catalog.json>.

## Any x402 resource

`client.pay_request(url, method="POST", json_body=...)` runs one paid call
against any x402 v2 resource under the same cap; nothing in it is
vendor-specific.

## License

MIT
