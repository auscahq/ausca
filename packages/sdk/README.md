# @ausca/sdk

The typed engine behind the [ausca](https://www.npmjs.com/package/ausca)
front door: catalog-bound invocations of
[Ausca](https://ausca.com) metered agent infrastructure services, paid per
call under a hard USD cap, with receipt-backed results.

Most consumers want the `ausca` package, which re-exports this entire
surface and adds the CLI and local MCP server. Depend on `@ausca/sdk`
directly when you only need the library.

## Client

```ts
import { AuscaClient, artifactInput } from "@ausca/sdk";

const client = AuscaClient.withLocalKey({
  privateKey: process.env.AUSCA_PRIVATE_KEY,
  maxPaymentUsd: 0.5,
});

const offer = await client.offer("document.ocr");
const price = await client.price("document.ocr");
const commitment = await client.commit(bytes, "application/pdf", { idempotencyKey: savedUploadKey });
const outcome = await client.invoke("document.ocr", { artifact: artifactInput(commitment) }, {
  idempotencyKey: savedPurchaseKey, // persist this unique key before paying
});
const state = await client.invocation("inv_...");
```

The envelope carries the offer's immutable revision and schema digests
exactly as the catalog declares. Each `invoke` starts with a
fresh idempotency key. For recovery after an uncertain response, retry with
the same caller-owned `idempotencyKey`; use a new key for a new intentional
purchase, even when the input is identical.

`InvocationUncertainError.identity` retains the offer id and key if transport
fails. No automatic purchase retry is performed. `onTrace` optionally reports
identity, request/revision digests, phase, HTTP status, and timing—never inputs,
headers, keys, or capabilities. Its first `request` callback runs before any
payment and may stop the call if durable identity storage fails; subsequent
diagnostic failures cannot turn a completed payment into a retry.

`client.probe(offerId, input)` returns the unsigned HTTP response and never
invokes payment authority, even on a funded client. Inspect the standard
`payment-required` header with the case-insensitive `Headers.get` API.
See the [executable recovery and browser-wallet examples](https://github.com/auscahq/ausca/tree/main/examples).

## Payment authorities

The client pays through a `PaymentAuthority`, a small port any rail can
implement: wrap a fetch so 402 challenges are paid within policy, and decode
settlement evidence from the response. Built in:

- `localKeyAuthority({ privateKey, maxPaymentUsd, network? })`: x402 v2 with
  a local signing key via the official `@x402/*` libraries.
- `x402Authority(config)`: the official x402 client configuration passed
  through verbatim, so any registered scheme client works.
- `inertAuthority()`: pays nothing; reads and price discovery.

Caps are enforced inside the authority before anything is signed.

## Artifact store

Artifact-backed offers take an immutable input commitment.
`client.commit(bytes, mediaType)` uses Ausca's keyless temporary ingress and
creates a fresh temporary commitment on every call. Pass
`{ idempotencyKey: "..." }` only to recover the same uncertain upload. The
client verifies the returned digest-backed evidence and returns the commitment
the invocation input carries. No account or API token is needed.
SDK commitment fields are camelCase; `artifactInput(commitment)` is the one
conversion into canonical snake_case business input. Do not pass the SDK
commitment object directly as `input.artifact`.
`ArtifactStore` remains the narrow port for a custom storage policy.

Successful paid state includes `receipt_ref.public_url`, an immutable
hash-only proof of the Ausca service, public price, completion time, and
receipt digest. It contains no request or result bytes, content digests, or
access capabilities. Anyone holding the unguessable URL can read it.

A result larger than the offer's inline bound arrives as `output_artifact`
instead of `output`. `client.artifactAccess(artifactRef)` mints a 60-second
download URL for it; verify the bytes against `contentDigest`. A failed
invocation carries `failure.code` and `failure.message`.

## Testkit

`@ausca/sdk/testkit` ships an in-process x402 v2 resource and an
Ausca-shaped service fixture (catalog, schema, payable route, invocation
read) for offline test suites. No chain is involved.

## License

MIT
