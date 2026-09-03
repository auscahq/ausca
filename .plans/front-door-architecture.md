# Ausca front door: architecture and code plan

Status: SHIPPED 2026-09-03. Approved by Kam, built (B1 to B6), npm chain
published and install-verified (@ausca/sdk 0.1.0, ausca 0.0.2,
@ausca/ai-sdk 0.1.0, unscoped ausca-ai-sdk deprecated), site and agent
surfaces aligned and deployed (B8). Open: PyPI publish awaits credentials
(dist ready); §8 MPP seller decision; §9.6 keyless ingestion decision.
Date: 2026-09-03. Owner: this repo (ausca-integrations).

## 1. Decision record

The front door for agents consuming Ausca services is one npm package,
`ausca`, that is a library, a CLI, and a local MCP server at once, over a
scoped engine `@ausca/sdk`. Decided 2026-09-03 after research; the shape is
final per Kam.

Why one package with three faces:

- An x402 payment is signed where the wallet key lives. Our remote MCP
  refuses without a settlement credential (`payment_authority_required`), so
  every consumption path needs a buyer-side component. The front door IS that
  component.
- Agents split three ways: code-execution agents want a library or CLI
  (Anthropic's code-execution-with-MCP guidance), MCP-host agents need a
  local stdio server via `npx`, and bare-HTTP agents follow SKILL.md with
  generic `@x402/*` libraries (already served, needs nothing here).
- Precedent: Stripe ships `@stripe/agent-toolkit` (library with per-surface
  subpaths) plus a thin `npx @stripe/mcp` runnable; Coinbase ships
  `payments-mcp` (npx local wallet MCP) and bundles an MCP server in
  `cdp-cli`. Convention: one core, a bin on top.
- Payment authority is a pluggable port from day 1. Stripe's Link CLI pays
  HTTP 402 merchants over MPP (shared payment tokens, card rails, 250M Link
  users); x402 v2 is the sibling stablecoin dialect. Hardwiring a raw viem
  key would be the brittle shape. Our own seller core is already rail
  neutral (CONTRACTS.md §3 `PaymentChallenge { settlement_family, ... }`
  names x402, Stripe, and SPT); the buyer side mirrors it.

## 2. Package graph

```
packages/payable          @ausca-internal/payable   private, never published
packages/sdk              @ausca/sdk                0.1.0  (renamed, done)
packages/ausca            ausca                     0.0.2  (patch of placeholder)
packages/ai-sdk           @ausca/ai-sdk             0.1.0  (renamed, done)
packages/langchain-ausca  langchain-ausca           0.1.1  (patch)
python/ausca              ausca (PyPI)              0.0.1  (built, unpublished)
```

Dependency rules, enforced by review:

- `packages/payable` holds the generic x402 kernel (`createPayableFetch`,
  `payableCall`, `paymentReceipt`) and the testkit. It is the single source
  for shared payable code (DRY), bundled via tsup `noExternal` into its
  consumers, never published, never imports anything Ausca-specific.
- `@ausca/sdk` bundles the kernel and adds the Ausca client, ports, and
  rails. Public runtime deps: `@x402/evm`, `@x402/fetch`; peer: `viem`.
- `ausca` depends on `@ausca/sdk` (public dep) plus the MCP SDK for its bin.
  It re-exports the sdk's public API unchanged and owns everything
  Node-specific (fs, env, process, stdio).
- `@ausca/ai-sdk` and `langchain-ausca` bundle ONLY the kernel and depend at
  runtime ONLY on official `@x402/*` libraries. They never import
  `@ausca/sdk`: their "works against any x402 resource" claim must be
  structurally true in the published dependency graph. This is already the
  case today (kernel is a bundled devDependency); the rework just repoints
  the bundle source from the old payable-core path to `packages/payable`.

Known intermediate state: adapters and the sdk still reference the old
`@ausca-internal/payable-core` name in imports and tsup config. The tree is
not expected to build until task B1 below lands. Do not publish anything
from this tree before the build sequence completes.

## 3. Ports (day-1 pluggability)

### 3.1 PaymentAuthority

```ts
export interface PaymentReceipt {
  readonly success: boolean;
  readonly transaction: string;
  readonly network: string;
  readonly payer: string;
}

/** A payment rail the client can pay 402 challenges with. */
export interface PaymentAuthority {
  /** Rail identifiers this authority satisfies, e.g. ["x402-v2"]. */
  readonly rails: readonly string[];
  /** Wrap a fetch so 402 challenges it understands are paid within policy. */
  wrapFetch(base: typeof globalThis.fetch): typeof globalThis.fetch;
  /** Decode settlement evidence from a completed response, if any. */
  receipt(response: Response): PaymentReceipt | null;
}
```

The wrap-a-fetch style is the port because every rail fits it: the official
x402 client is literally a fetch wrapper; a delegated executor like
`link-cli mpp pay` (which performs its own HTTP) substitutes its transport
inside the wrapper. The core never sees a rail, a header name, or a scheme.
Cap enforcement lives inside the authority, before anything is signed.

Rail-neutral positioning is a key part of the shape, per Kam 2026-09-03:
the front door's identity is metered Ausca services, never one settlement
protocol. Package descriptions and READMEs for `ausca` and `@ausca/sdk`
say "paid per call" and list rails as current implementations with x402
first; nothing outside authority implementations may name a rail, decode a
challenge, or read a payment header. The two framework adapters stay
x402-branded deliberately: that ecosystem niche is their identity.

Constructors shipped day 1:

- `localKeyAuthority({ privateKey | account, maxPaymentUsd, network? })`:
  x402 v2 exact-EVM with a local viem account via
  `wrapFetchWithPaymentFromConfig` + `spendControls`. The zero-friction
  default; network defaults to Base mainnet.
- `x402Authority({ schemes, spendControls })`: passthrough of the official
  x402 client config, so ANY scheme client the ecosystem registers (CDP
  wallets, Solana, future schemes) plugs in without us shipping code.
- The bare interface for everything else. `linkCliAuthority` is sketched in
  docs but NOT built until Ausca's seller side emits MPP challenges (§8);
  shipping a payer for a rail our routes don't speak would be a lie.
- `inertAuthority()`: pays nothing; read-only clients (catalog, price
  discovery) and tests construct with it instead of a fake wallet.

### 3.2 ArtifactStore

Artifact-backed offers (extract-text, analyze-document, transcribe-media)
require an input commitment `{ artifact_ref, content_digest, media_type }`
where `artifact_ref` is `runx:artifact:sha256:<64hex>`
(contracts/schemas/common/artifact-commitment.schema.json). Grounded flow,
pinned by the vendored hosted OpenAPI (`POST /v1/artifact-operations`):

1. `artifact.allocate` with `{ idempotency_key, data_base64,
   content_digest, media_type }` returns HostedArtifactEvidence.
2. `artifact.handoff` with `{ source_artifact_ref, target_principal_id,
   idempotency_key }` copies to the registered `ausca` execution principal.

Auth is a self-serve bearer principal (verified in runx cloud
`artifact-operation-routes.ts`: `authenticateSelfServe`, no hosted-run
lookup), so external buyers with a Runx token can commit inputs today.

```ts
export interface ArtifactCommitment {
  readonly artifactRef: string;
  readonly contentDigest: string;
  readonly mediaType: string;
}

export interface ArtifactStore {
  commit(bytes: Uint8Array, mediaType: string): Promise<ArtifactCommitment>;
}
```

- `runxArtifactStore({ token, targetPrincipalId, origin?, runContext? })`:
  computes sha256, derives both idempotency keys from the digest (replay
  safe), allocates, hands off, returns the commitment.
- Build-time verification task: confirm the exact accepted `run_id` value
  for self-serve external allocation against runx cloud (schema requires a
  1..256 char string; confirm free-form context is admitted) and the
  registered ausca principal id to document as the default.

Honest gap, flagged, not patched: a keyless buyer (wallet only, no Runx
account) cannot use artifact-backed offers end to end. Browser and inbox
offers are fully keyless already. The clean fix would be an Ausca-owned
payable ingestion route (an x402-priced upload offer that returns a
commitment). That is a service and pricing decision for Kam (§9), out of
scope here; the port means the client gains it with zero API change.

## 4. @ausca/sdk (engine)

```
src/payable.ts     re-export surface of the kernel (bundled)
src/payment.ts     PaymentAuthority port + localKeyAuthority + x402Authority
src/artifacts.ts   ArtifactStore port + runxArtifactStore
src/client.ts      AuscaClient + errors + types
src/index.ts       public API
src/testkit.ts     in-process x402 v2 test server (exists) + catalog fixture
```

Public client API:

```ts
export const ORIGIN = "https://ausca.com";
export const CATALOG_URL = `${ORIGIN}/catalog.json`;
export const SKILL_URL = `${ORIGIN}/SKILL.md`;

export interface AuscaClientOptions {
  readonly payment: PaymentAuthority;
  readonly artifacts?: ArtifactStore;
  readonly origin?: string;                    // tests
  readonly fetch?: typeof globalThis.fetch;    // tests, custom transports
}

export class AuscaClient {
  constructor(options: AuscaClientOptions);
  /** Sugar for the default rail: local key, hard USD cap. */
  static withLocalKey(options: {
    privateKey?: `0x${string}`; account?: LocalAccount;
    maxPaymentUsd: number; network?: string;
    origin?: string; artifacts?: ArtifactStore;
  }): AuscaClient;

  catalog(options?: { refresh?: boolean }): Promise<Catalog>;
  offer(offerId: string): Promise<Offer>;
  /** Published price policy from the catalog. No wallet, no rail code. */
  price(offerId: string): Promise<Price>;
  /** Deterministic envelope; idempotency key from offer+input digest. */
  envelope(offer: Offer, input: unknown, idempotencyKey?: string):
    Promise<Record<string, unknown>>;
  /** Probe, pay within policy, return result + settlement proof. */
  invoke(offerId: string, input: unknown,
    options?: { idempotencyKey?: string }): Promise<InvocationResult>;
  /** Durable read until terminal state. */
  invocation(invocationId: string): Promise<InvocationState>;
  /** Commit input bytes via the configured ArtifactStore. */
  commit(bytes: Uint8Array, mediaType: string): Promise<ArtifactCommitment>;
}
```

Behavioural contract (carried over from the shipped client + SKILL.md):

- Envelope carries offer_id, revision, revision digest, schema digests,
  canonicalizer, input, idempotency key, exactly as the catalog declares.
- Default idempotency key = `ausca-` + sha256(offer_id, revision_digest,
  input)[:32]; an uncertain retry can never mint a second purchase.
- Unsigned first send is discovery; the paid retry reuses the same bytes
  and key. Receipt decoded by the authority from the settled response.
- Typed errors: `AuscaError` base; `OfferNotActiveError`, `RefusalError`
  (typed refusal envelope, e.g. "Offer is not served on this payable
  resource."), `PaymentCapError` (authority declined within policy),
  `ArtifactError`, `CatalogError`. No stringly-typed failures.
- Zero Node-specific imports: WebCrypto, fetch, TextEncoder only, so the
  sdk runs in workers and edge runtimes. File handling lives in the bin.

## 5. ausca (front door)

`packages/ausca`:

```
src/index.ts       export * from "@ausca/sdk"
src/bin.ts         verb router (bin: { "ausca": "dist/bin.js" })
src/cli.ts         catalog | price | invoke | commit
src/mcp.ts         local stdio MCP server
```

### 5.1 CLI

Minimal verbs, defaults over flags, JSON to stdout:

```
ausca catalog                    active offers, prices, routes
ausca price <offer-id>           unsigned floor quote, no wallet needed
ausca invoke <offer-id> [input]  input = inline JSON, @file, or stdin
ausca commit <file>              artifact commitment (media type sniffed)
ausca mcp                        stdio MCP server
```

Env contract (the only configuration):

- `AUSCA_PRIVATE_KEY`: pays; required by invoke and mcp paid tools.
- `AUSCA_MAX_PAYMENT_USD`: required whenever a key is present; no silent
  default cap, refusing to guess a spend limit is the safe shape.
- `AUSCA_NETWORK`: optional, defaults to Base mainnet.
- `RUNX_API_TOKEN`: enables commit and artifact-backed invokes.

### 5.2 Local MCP server

Official MCP TypeScript SDK, stdio transport. Tools are derived from the
live catalog at startup, never hand-listed (self-syncing): one tool per
active offer, named to match the remote server (`ausca_extract_text`,
`ausca_analyze_document`, `ausca_transcribe_media`, `ausca_lease_browser`,
`ausca_open_inbox`, `ausca_extend_inbox`), input schema taken from the
offer's published input schema. Plus `ausca_catalog`, `ausca_price`, and
`ausca_commit_artifact` (registered only when `RUNX_API_TOKEN` is set).
All payment flows through the same client and authority; the MCP layer
contains zero payment code. Wallet and cap come from env exactly as the
CLI. Build-time verification: the catalog's schema link shape (digest vs
resolvable URL); if schemas are not fetchable, tools declare bounded
object schemas and defer validation to the service, no invented schemas.

Registration of the local server in the MCP registry (npm-linked entry)
happens later from the session holding the com.ausca DNS key; not part of
this build.

## 6. Adapters rework (@ausca/ai-sdk, langchain-ausca)

- Repoint kernel bundling from `@ausca-internal/payable-core` to
  `@ausca-internal/payable`; runtime deps stay `@x402/*` only.
- `@ausca/ai-sdk` 0.1.0: publish under the scope, then
  `npm deprecate ausca-ai-sdk "renamed to @ausca/ai-sdk"`.
- `langchain-ausca` 0.1.1: patch republish with the rebundled kernel.
  Stays unscoped per the LangChain `langchain-<vendor>` convention.
- No adapter API changes; their tests keep running against the testkit.

## 7. Python parity (python/ausca, built, unpublished)

Mirror the ports so the two clients stay structurally identical:

- `PaymentAuthority` protocol wrapping `x402ClientSync` config; built-in
  local-key authority; passthrough authority for any registered scheme.
- `RunxArtifactStore` with the same allocate + handoff flow.
- Console script `ausca` with the same verbs (catalog, price, invoke,
  commit). Python MCP is deferred: `npx ausca mcp` already serves MCP
  hosts, and the Python package targets code-execution agents; revisit if
  uvx-based MCP demand appears.
- Version stays 0.0.1 (unpublished); the port refactor lands before first
  publish so the public API is right from day one. Publication blocked on
  PyPI credentials (Kam).

## 8. Seller-side MPP dual rail (assessment only, Kam's decision)

What accepting Stripe Link buyers would take, researched 2026-09-03:

- Buyer flow: Link CLI decodes a `WWW-Authenticate: Payment ...` challenge,
  creates a customer-approved spend request, completes with a one-time
  shared payment token. Stripe settles to a Stripe balance in fiat.
- Our 402 responses can carry both dialects on the same routes: MPP in the
  `WWW-Authenticate` header, x402 v2 in the body/PAYMENT-REQUIRED header;
  the retry credential headers differ, so admission can route by header.
- Our core was built for this: CONTRACTS.md §3 adds a rail as a schema plus
  adapter; the six operations, offer domain, and provider packages do not
  change.
- Requirements and frictions: Stripe account with machine payments; SPT
  card minimum is $0.50, so document.ocr at $0.30 is card-ineligible at
  current pricing (MPP stablecoin minimum is 0.01 USDC and fine);
  stablecoin path excluded in New York; non-US acceptance by request.
- Recommendation: do it as its own workstream after the front door ships;
  the buyer-side port means the packages need zero changes when it lands.

## 9. Decisions needed from Kam

1. Approve this plan (build sequence §10 starts only after sign-off).
2. Version table sign-off: @ausca/sdk 0.1.0 (new identity), ausca 0.0.2
   (patch), @ausca/ai-sdk 0.1.0 (new identity), langchain-ausca 0.1.1
   (patch), python ausca 0.0.1 (first publish).
3. @ausca npm org: add auscaster, or publish from the owning login.
4. PyPI credentials or trusted publisher for `ausca`.
5. MPP dual-rail seller workstream: go/no-go, and pricing stance for the
   $0.50 card minimum.
6. Keyless ingestion offer (payable upload returning a commitment): worth
   a product slot, or is "artifact offers require a Runx principal" the
   intended posture?

## 10. Build sequence (after approval)

- B1 kernel split: create `packages/payable` (@ausca-internal/payable) from
  the existing payable.ts + testkit; repoint sdk and both adapters; green
  workspace build + tests.
- B2 sdk ports: payment.ts (port + localKeyAuthority + x402Authority),
  artifacts.ts (port + runxArtifactStore), client.ts reworked onto the
  ports (constructor takes `payment`, sugar `withLocalKey`), errors typed,
  price() and invocation() added; unit tests against testkit including a
  non-key authority double proving the port.
- B3 front door: bin router, CLI verbs, MCP server; tests: CLI against
  testkit + catalog fixture, MCP via in-process client; README for both
  packages (uppercase convention, no competitor names, voice rules).
- B4 adapters: rebundle, tests green, no API drift.
- B5 python: port refactor mirroring B2, CLI verbs, tests, README.
- B6 verification pass: full workspace build, all tests, a live keyless
  smoke against browser-duration price discovery (unsigned only, no
  spend without Kam).
- B7 publish (blocked on §9.3): @ausca/sdk, ausca 0.0.2, @ausca/ai-sdk +
  deprecate unscoped, langchain-ausca 0.1.1; PyPI when §9.4 unblocks.
- B8 docs alignment in the ausca repo: DISTRIBUTION.md records the front
  door; site install snippets reference `npm i ausca` / `npx ausca mcp`
  (same pass, per the align-all-surfaces rule).
