# @ausca/ai-sdk

Vercel AI SDK tools that consume paid HTTP APIs by answering `402 Payment
Required` with an [x402](https://www.x402.org) v2 payment, instead of carrying
an API key. The model authors the request; the wallet and a hard per-call USD
cap stay with your code.

Works against any x402 v2 resource. [Ausca](https://ausca.com) is the default
example because its services are keyless and receipt-backed, which is the shape
this tool exists for.

## Install

```bash
npm install @ausca/ai-sdk ai viem zod
```

## Use

```ts
import { generateText } from "ai";
import { x402Tool } from "@ausca/ai-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`);

const result = await generateText({
  model: yourModel,
  prompt: "Extract the text from the uploaded scan.",
  tools: {
    // Document OCR on Ausca: copy the exact offer binding from
    // https://ausca.com/catalog.json (offer document.ocr).
    extract_document_text: x402Tool({
      description:
        "Extracts normalized text from a scanned document for $0.30. Input is the immutable artifact commitment of the uploaded document.",
      inputSchema: z.object({
        artifact_ref: z.string(),
        content_digest: z.string(),
        media_type: z.string(),
      }),
      url: "https://ausca.com/v1/extract-text",
      account,
      maxPaymentUsd: 0.5,
      buildBody: (input) => ({
        offer_id: "document.ocr",
        input: { artifact: input },
        idempotency_key: `ocr-${input.content_digest.slice(7, 27)}`,
      }),
    }),
  },
});
```

The tool result carries the resource result and, when the call was paid, the
decoded settlement proof from the `PAYMENT-RESPONSE` header.

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
