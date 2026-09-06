# langchain-ausca

LangChain tools that pay for HTTP 402 APIs over
[x402](https://pypi.org/project/x402/) instead of carrying API keys. A tool
built here works against any x402 v2 resource; nothing in it is specific to
one vendor. The model authors the request; the caller's signing key and hard
per-call USD cap stay outside the model's reach, enforced by the official
x402 library's spend controls before anything is signed.

## Install

```bash
pip install langchain-ausca
```

## Use

```python
import os
from langchain_ausca import payable_tool
from pydantic import BaseModel

class LeaseBrowser(BaseModel):
    duration_seconds: int

browser = payable_tool(
    name="lease_browser",
    description="Lease a remote browser with CDP access for 10, 30, or 60 minutes. Costs $0.10 to $0.25 in USDC on Base.",
    args_schema=LeaseBrowser,
    url="https://ausca.com/v1/lease-browser",
    private_key=os.environ["WALLET_PRIVATE_KEY"],  # pays USDC on Base
    max_payment_usd=0.50,                          # hard per-call cap
)
```

The tool result is a JSON string with the resource result and, when the call
was paid, the decoded settlement proof from the `PAYMENT-RESPONSE` header.

The example uses [Ausca](https://ausca.com), pay-per-call agent
infrastructure services with no accounts or API keys; its catalog-bound
Python client is the [`ausca`](https://pypi.org/project/ausca/) package. Any
other x402 v2 resource works the same way: point `url` at it.

The npm sibling of this package is
[`langchain-ausca`](https://www.npmjs.com/package/langchain-ausca).

## License

MIT
