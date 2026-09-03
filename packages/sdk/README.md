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
import { AuscaClient } from "@ausca/sdk";

const client = AuscaClient.withLocalKey({
  privateKey: process.env.AUSCA_PRIVATE_KEY,
  maxPaymentUsd: 0.5,
});

const offer = await client.offer("document.ocr");
const price = await client.price("document.ocr");
const outcome = await client.invoke("document.ocr", { artifact });
const state = await client.invocation("inv_...");
```

The envelope carries the offer's immutable revision, schema digests, and
canonicalizer exactly as the catalog declares, with a deterministic
idempotency key derived from the offer and input.

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
`runxArtifactStore({ token })` commits bytes through the hosted Runx
artifact boundary with digest-derived idempotency and returns the
commitment; `ArtifactStore` is the port for future ingestion rails.

## Testkit

`@ausca/sdk/testkit` ships an in-process x402 v2 resource and an
Ausca-shaped service fixture (catalog, schema, payable route, invocation
read) for offline test suites. No chain is involved.

## License

MIT
