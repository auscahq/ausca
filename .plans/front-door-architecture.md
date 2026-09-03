# Ausca client and integration architecture

Status: current build authority, 2026-09-03.

## Product boundary

Ausca is one standalone pay-per-call service. This repository contains only
public buyer-side clients and ecosystem metadata. It owns no service runtime,
provider credential, settlement backend, hosted state, or product contract.

The live authorities are:

- `https://ausca.com/SKILL.md` for the agent workflow;
- `https://ausca.com/catalog.json` for active offers, prices, limits, and
  immutable bindings;
- `https://ausca.com/openapi.yaml` for HTTP and MCP application contracts;
- `https://ausca.com/server.json` for official MCP Registry metadata.

Clients resolve those authorities at runtime. They do not restate service
prices, revisions, schemas, routes, retention, or provider details.

## Package graph

```text
packages/payable          private shared x402 kernel; never published
packages/sdk              @ausca/sdk; typed rail-neutral engine
packages/ausca            ausca; default library + CLI + local MCP server
packages/ai-sdk           @ausca/ai-sdk; vendor-neutral x402 tools
packages/langchain-ausca  langchain-ausca; vendor-neutral x402 tools
python/ausca              ausca; typed Python client + CLI
```

Dependency rules:

- `packages/payable` contains the one shared payable implementation and is
  bundled into consumers.
- `@ausca/sdk` owns the typed client, `PaymentAuthority`, and `ArtifactStore`
  ports. It contains no CLI, MCP host, filesystem, or environment logic.
- `ausca` re-exports the SDK and owns Node-specific CLI, environment, and
  local stdio MCP concerns.
- Framework adapters use only the vendor-neutral payable kernel and official
  x402 libraries. They do not import the Ausca SDK.
- The Python client follows the same port and lifecycle shape without trying
  to share implementation code across languages.

## Payment boundary

The client core only knows `PaymentAuthority`: wrap a fetch within policy and
decode settlement evidence. The built-in local-key authority supports x402 v2
through official libraries and requires a positive caller-selected per-call
USD cap. Future rails implement the same port.

Wallet material stays in the buyer process. It is never sent to Ausca, placed
in model-authored MCP arguments, logged, or included in receipts.

## Artifact boundary

`AuscaArtifactStore` is the default and calls keyless `POST /v1/artifacts`.
It computes the SHA-256 digest locally, sends canonical base64 with a stable
idempotency key, and verifies the complete returned commitment. The live offer
catalog sets the usable size and retention policy; the client's 25 MiB value is
only the platform ceiling and does not widen an offer.

`ArtifactStore` remains a narrow replacement port. No caller needs a hosted
account or a separate storage credential for the default flow.

## Invocation and recovery

For one intentional purchase the client:

1. resolves the active offer and its immutable contract bindings;
2. builds and canonicalizes the exact invocation envelope;
3. probes the offer route without payment material;
4. permits the configured authority to pay only within its cap;
5. retries the same request bytes and idempotency identity; and
6. reads the same invocation to terminal state after an uncertain response.

Each intentional call starts with a fresh purchase identity. The SDK, CLI, and
local MCP surface also accept a caller-owned identity for recovery; callers
reuse it only for the same intended purchase and choose a new one for another
purchase with identical input. The client never treats a transport close as a
terminal business outcome or creates a second purchase merely to discover the
first outcome.

Successful paid state contains `receipt_ref.public_url`, an immutable
hash-only verification page disclosing the receipt digest, Ausca service,
public price, and completion time. It contains no request/result bytes,
content digests, access capabilities, payment credentials, or provider
evidence. Anyone holding the unguessable URL can read it.

## MCP surfaces

The remote Streamable HTTP server at `https://ausca.com/mcp` exposes public
discovery, preparation, state, cancellation, and capability-scoped lifecycle
tools. It does not accept wallet secrets as tool arguments.

`npx ausca mcp` is the local wallet-holding MCP option. With no wallet
environment it still supports discovery and keyless artifact commit. Paid
tools require both `AUSCA_PRIVATE_KEY` and `AUSCA_MAX_PAYMENT_USD`.

`server.json` advertises both surfaces under `com.ausca/agent-services` and is
verified against package versions by `npm run verify:metadata`.

## Distribution metadata

- `server.json`: official MCP Registry document.
- `glama.json`: Glama organization-repository ownership.
- `context7.json`: Context7 parsing instructions.
- package `repository` and `bugs`: exact public GitHub origin.
- package `mcpName`: exact official registry identity.

A2A metadata is intentionally absent. Ausca does not expose an A2A protocol
endpoint, so advertising an Agent Card would create a false interface.

## Build and release

Run locally before any remote mutation:

```bash
npm ci
npm test
npm run build
python -m pytest python/ausca/tests
python -m build python/ausca
```

Release order:

1. verify a clean diff and scan tracked content plus history for credentials;
2. commit and push the public repository;
3. publish `@ausca/sdk`, then `ausca`, then the Python package when its
   registry credential is available;
4. install published versions into clean temporary directories and run basic
   catalog/artifact/MCP startup checks;
5. publish the already-live remote and released npm package through
   `server.json` to the official MCP Registry;
6. submit the public repository to Context7 and Glama; and
7. record provider readback and current versions in Ausca's distribution
   runbook.

Never publish from an untested tree, republish an existing version, or claim a
directory/package release without registry readback.
