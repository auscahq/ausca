# ausca-integrations

The buyer-side packages for [Ausca](https://ausca.com) metered agent services,
plus vendor-neutral framework adapters that let agent tools pay for HTTP 402
APIs over x402 v2 instead of carrying API keys.

- [ausca](packages/ausca): the front door. Library re-export of `@ausca/sdk`
  plus the `ausca` bin: CLI verbs and the local wallet-holding MCP server.
- [@ausca/sdk](packages/sdk): the engine. Typed Ausca client, catalog-bound
  envelopes, pluggable payment authority and artifact store ports.
- [@ausca/ai-sdk](packages/ai-sdk): Vercel AI SDK tools for any x402 v2
  resource; Ausca is the default example.
- [langchain-ausca](packages/langchain-ausca): LangChain structured tools for
  any x402 v2 resource; Ausca is the default example.
- `packages/payable`: the internal shared x402 kernel and testkit, bundled
  where needed, never published.

Payment construction and signing live entirely in the official `@x402/*`
client libraries; these packages configure them, enforce a per-call USD cap
through the client's spend controls, and return results with the decoded
settlement proof. The framework adapters depend only on the official
libraries at runtime.

The [python/ausca](python/ausca) package is the Python equivalent of the
front door; Python framework adapters follow the same contract.

Architecture and build plan: [.plans/front-door-architecture.md](.plans/front-door-architecture.md).
