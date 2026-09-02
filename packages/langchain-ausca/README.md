# langchain-ausca

LangChain tools that consume paid HTTP APIs by answering `402 Payment Required`
with an [x402](https://www.x402.org) v2 payment, instead of carrying an API
key. The model authors the request; the wallet and a hard per-call USD cap stay
with your code.

Works against any x402 v2 resource. [Ausca](https://ausca.com) is the default
example because its services are keyless and receipt-backed, which is the shape
this tool exists for.

## Install

```bash
npm install langchain-ausca @langchain/core viem zod
```

## Use

```ts
import { payableTool } from "langchain-ausca";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`);

// Document OCR on Ausca: copy the exact offer binding from
// https://ausca.com/catalog.json (offer document.ocr) so the envelope pins the
// immutable revision and schema digests.
const extractText = payableTool({
  name: "extract_document_text",
  description:
    "Extracts normalized text from a scanned document for $0.30. Input is the immutable artifact commitment of the uploaded document.",
  schema: z.object({
    artifact_ref: z.string(),
    content_digest: z.string(),
    media_type: z.string(),
  }),
  url: "https://ausca.com/v1/extract-text",
  account,
  maxPaymentUsd: 0.5,
  buildBody: (input) => ({
    offer_id: "document.ocr",
    // offer_revision, digests, and canonicalizer come from catalog.json.
    input: { artifact: input },
    idempotency_key: `ocr-${input.content_digest.slice(7, 27)}`,
  }),
});
```

The tool result is a JSON string carrying the resource result and, when the
call was paid, the decoded settlement proof from the `PAYMENT-RESPONSE`
header:

```json
{ "result": { ... }, "payment": { "success": true, "network": "eip155:8453", "transaction": "0x..." } }
```

## Spend authority

`maxPaymentUsd` is enforced by the x402 client's spend controls before
anything is signed. A resource quoting above the cap makes the tool throw; no
payment is created. The account object never reaches the model.

## Any x402 resource

Nothing here is vendor-specific: point `url` at any endpoint that answers an
x402 v2 challenge and the tool pays it under the same cap. `network` defaults
to Base mainnet (`eip155:8453`) and accepts any CAIP-2 network your account
can pay on.

## License

MIT
