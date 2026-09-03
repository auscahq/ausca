import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { startAuscaService } from "@ausca/sdk/testkit";

import { buildMcpServer } from "./mcp.js";

const TEST_KEY = `0x${"7".repeat(64)}`;

async function connectedClient(env: Record<string, string>): Promise<Client> {
  const server = await buildMcpServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function firstText(result: { content?: unknown }): unknown {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

describe("ausca mcp server", () => {
  it("derives per-offer tools from the live catalog with real input schemas", async () => {
    const service = await startAuscaService();
    try {
      const client = await connectedClient({
        AUSCA_ORIGIN: service.origin,
        AUSCA_PRIVATE_KEY: TEST_KEY,
        AUSCA_MAX_PAYMENT_USD: "0.05",
      });
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("ausca_echo");
      expect(names).toContain("ausca_catalog");
      expect(names).toContain("ausca_price");
      expect(names).not.toContain("ausca_commit_artifact");
      const echo = tools.find((tool) => tool.name === "ausca_echo");
      expect(echo?.inputSchema.required).toEqual(["message"]);
      expect(echo?.description).toContain("$0.01 per call");
      await client.close();
    } finally {
      await service.close();
    }
  });

  it("pays a derived tool call and returns the settlement proof", async () => {
    const service = await startAuscaService();
    try {
      const client = await connectedClient({
        AUSCA_ORIGIN: service.origin,
        AUSCA_PRIVATE_KEY: TEST_KEY,
        AUSCA_MAX_PAYMENT_USD: "0.05",
      });
      const outcome = firstText(
        await client.callTool({ name: "ausca_echo", arguments: { message: "paid" } }),
      ) as { payment: { success: boolean }; result: { result: { echo: { message: string } } } };
      expect(outcome.payment.success).toBe(true);
      expect(outcome.result.result.echo.message).toBe("paid");
      expect(service.requests).toEqual({ unsigned: 1, signed: 1 });
      await client.close();
    } finally {
      await service.close();
    }
  });

  it("lists paid tools without a key but refuses to call them", async () => {
    const service = await startAuscaService();
    try {
      const client = await connectedClient({ AUSCA_ORIGIN: service.origin });
      const { tools } = await client.listTools();
      const echo = tools.find((tool) => tool.name === "ausca_echo");
      expect(echo?.description).toContain("AUSCA_PRIVATE_KEY");
      const result = await client.callTool({ name: "ausca_echo", arguments: { message: "no" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(firstText(result))).toContain("cannot pay");
      expect(service.requests.signed).toBe(0);

      const catalog = firstText(
        await client.callTool({ name: "ausca_catalog", arguments: {} }),
      ) as { offer_id: string }[];
      expect(catalog[0].offer_id).toBe("echo.test");
      await client.close();
    } finally {
      await service.close();
    }
  });
});
