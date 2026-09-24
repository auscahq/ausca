<p align="center">
  <img src="https://ausca.com/favicon.svg" alt="Ausca" width="72" height="72" />
</p>

<h1 align="center">Ausca</h1>

<p align="center">
  Pay-per-call APIs and MCP services for AI agents: document OCR, document
  analysis, media transcription, remote browser sessions, and agent email
  inboxes. No account, no API keys; USDC on Base per call, a signed receipt
  for every completed invocation.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ausca"><img src="https://img.shields.io/npm/v/ausca?label=npm%20ausca" alt="npm ausca" /></a>
  <a href="https://www.npmjs.com/package/@ausca/sdk"><img src="https://img.shields.io/npm/v/%40ausca%2Fsdk?label=%40ausca%2Fsdk" alt="npm @ausca/sdk" /></a>
  <a href="https://pypi.org/project/ausca/"><img src="https://img.shields.io/pypi/v/ausca?label=PyPI%20ausca" alt="PyPI ausca" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-black" alt="MIT license" /></a>
  <a href="https://registry.modelcontextprotocol.io/v0/servers?search=com.ausca"><img src="https://img.shields.io/badge/MCP%20registry-com.ausca%2Fagent--services-black" alt="MCP registry" /></a>
  <a href="https://smithery.ai/servers/ausca/agent-services"><img src="https://img.shields.io/badge/Smithery-ausca%2Fagent--services-black" alt="Smithery" /></a>
</p>

Agents buy infrastructure the way they call tools: send the request, pay the
402 challenge within a hard USD cap you set, read the result and its
settlement proof. The catalog, prices, and schemas are immutable and public
at [ausca.com/catalog.json](https://ausca.com/catalog.json); the full agent
contract is [ausca.com/SKILL.md](https://ausca.com/SKILL.md).

## Agent skills

Install one canonical skill from this public repository:

```sh
npx -y skills add auscahq/ausca --skill agent-inbox
```

Replace `agent-inbox` with `browser-session`, `document-analysis`,
`document-ocr`, or `media-transcription`. Install all five with:

```sh
npx -y skills add auscahq/ausca --skill '*'
```

## Services and prices

| Service | What it does | Price (USD) |
| --- | --- | --- |
| Document OCR | Normalized text with line confidence from one committed document | $0.25 per document |
| Document Analysis | Normalized forms, tables, signatures, or layout from one committed document | $0.30 to $0.75, sized by document bytes |
| Media Transcription | Normalized transcript of one committed audio or video file | $0.40 to $1.30, sized by media bytes |
| Browser Session | Remote browser with standard CDP access | $0.05 / 10 min, $0.10 / 30 min, $0.20 / 60 min |
| Agent Inbox | A renewable receive-only email address your agent owns | $0.05 / hour, $0.20 / day, $1.00 / week |
| Inbox Extension | Add time to an active inbox without changing its address | $0.05 / hour, $0.20 / day, $1.00 / week |

Prices are the public catalog values at the time of writing; the live
catalog is authoritative.

## Use it in 60 seconds

**MCP** (Claude Desktop, Cursor, any MCP host): the local server holds your
wallet and pays within your cap. Tools are derived from the live catalog.

```json
{
  "mcpServers": {
    "ausca": {
      "command": "npx",
      "args": ["-y", "ausca", "mcp"],
      "env": {
        "AUSCA_PRIVATE_KEY": "0x...",
        "AUSCA_MAX_PAYMENT_USD": "0.50"
      }
    }
  }
}
```

**TypeScript**

```ts
import { AuscaClient } from "ausca";

const client = AuscaClient.withLocalKey({
  privateKey: process.env.AUSCA_PRIVATE_KEY, // pays USDC on Base
  maxPaymentUsd: 0.5,                        // hard per-call cap
});

const outcome = await client.invoke("browser.session", { duration_seconds: 600 }, {
  idempotencyKey: savedPurchaseKey,
  attribution: { source: "my-agent", campaign: "browser-workflow" }, // optional
});
console.log(outcome.result, outcome.payment?.transaction);
```

**CLI**

```bash
npx ausca catalog
npx ausca price document.ocr
AUSCA_PRIVATE_KEY=0x... AUSCA_MAX_PAYMENT_USD=0.50 \
  npx ausca invoke browser.session '{"duration_seconds":600}' --idempotency-key saved-browser-purchase-0001
  # Add --source my-agent [--campaign browser-workflow] for optional attribution.
```

**Python**

```bash
pip install ausca
```

```python
from ausca import AuscaClient, InvocationAttribution

client = AuscaClient.with_local_key(private_key=key, max_payment_usd=0.50)
outcome = client.invoke(
    "browser.session",
    {"duration_seconds": 600},
    idempotency_key=saved_purchase_key,
    attribution=InvocationAttribution(source="my-agent", campaign="browser-workflow"),
)
```

A remote MCP server also runs at `https://ausca.com/mcp` (Streamable HTTP)
for discovery, preparation, and state reads; payment always signs on your
side, which is why the local server exists.

## How payment works

Every service is an [x402 v2](https://ausca.com/.well-known/x402) payable
resource. An unsigned request returns the exact payment requirement; the
client pays it only if it fits your cap, then retries the same bytes with
the same idempotency key. Save a unique key before paying and retain it on
uncertainty; starting another call with a new key is a new purchase. CLI and
paid MCP calls require an explicit key. Resource admission contains private
capabilities: never publish the raw result. See [recovery examples](examples).
Settlement is USDC on Base and every completed invocation carries a receipt
with a public, hash-only verification page. Payment rails are pluggable
behind one interface; the official `@x402/*` libraries do all signing.

Optional source/campaign attribution is reporting metadata only and is
excluded from pricing, payment, execution, and recovery identity. Caller
labels are self-reported.

Document and media services take an immutable artifact commitment instead
of raw bytes: `npx ausca commit file.pdf` uploads through the keyless
ingress and returns the commitment the offer input carries.

## What is in this repository

| Package | Registry | What it is |
| --- | --- | --- |
| [`ausca`](packages/ausca) | [npm](https://www.npmjs.com/package/ausca) | The front door: library, CLI, and local MCP server |
| [`@ausca/sdk`](packages/sdk) | [npm](https://www.npmjs.com/package/@ausca/sdk) | The typed engine: client, payment authorities, artifact store |
| [`ausca`](python/ausca) | [PyPI](https://pypi.org/project/ausca/) | Python client and CLI with the same ports |
| [`@ausca/ai-sdk`](packages/ai-sdk) | [npm](https://www.npmjs.com/package/@ausca/ai-sdk) | Vercel AI SDK tools for any x402 v2 resource |
| [`langchain-ausca`](packages/langchain-ausca) | [npm](https://www.npmjs.com/package/langchain-ausca) | LangChain tools for any x402 v2 resource |
| [`skills/`](skills) | [ausca.com](https://ausca.com/skills/document-ocr/SKILL.md) | Agent skills, mirrored from the live origin |

The service runtime is not in this repository; this is the complete public
buyer side. `server.json` carries the official MCP registry identity
`com.ausca/agent-services`.

## Links

- Agent contract: <https://ausca.com/SKILL.md>
- Live catalog: <https://ausca.com/catalog.json>
- OpenAPI: <https://ausca.com/openapi.json>
- x402 discovery: <https://ausca.com/.well-known/x402>
- Docs: <https://ausca.com/docs>

## License

MIT
