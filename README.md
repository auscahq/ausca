# ausca-integrations

Framework integrations that let agent tools pay for HTTP 402 APIs over x402 v2
instead of carrying API keys. One shared kernel, thin adapters per ecosystem:

- [langchain-ausca](packages/langchain-ausca): LangChain structured tools
- [ausca-ai-sdk](packages/ausca-ai-sdk): Vercel AI SDK tools
- `packages/payable-core`: the internal shared kernel, bundled into both,
  never published

Payment construction and signing live entirely in the official `@x402/*`
client libraries; these packages configure them, enforce a per-call USD cap
through the client's spend controls, and shape framework-native results with
the decoded settlement proof.

Python equivalents (`langchain-ausca` on PyPI, a LlamaIndex tool spec) follow
the same contract once PyPI publishing credentials exist.
