import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { MAX_ARTIFACT_BYTES, type AuscaClient, type Price } from "@ausca/sdk";

import packageMetadata from "../package.json";

import {
  clientFromEnvironment,
  paymentFromEnvironment,
  type Environment,
} from "./env.js";

// The local MCP server: the half of the MCP story the hosted transport
// structurally cannot do, because payment signs where the key lives. Tools
// are derived from the live catalog at startup, names taken from the
// catalog's own MCP projection, input schemas fetched from the published
// schema paths. Nothing here is hand-listed and nothing here pays outside
// the configured authority.

const PERMISSIVE_INPUT = { type: "object" } as const;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_ARTIFACT_BYTES / 3);
const IDEMPOTENCY_ARGUMENT = "ausca_idempotency_key";
const SOURCE_ARGUMENT = "ausca_source";
const CAMPAIGN_ARGUMENT = "ausca_campaign";

interface DerivedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly offerId?: string;
}

function priceSummary(price: Price): string {
  const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;
  if (price.options?.length) {
    const options = price.options
      .map((option) => `${usd(option.amountMinor)} for ${JSON.stringify(option.value)}`)
      .join(", ");
    return `${options} (${price.inputField})`;
  }
  if (price.minimumMinor === price.maximumMinor) {
    return `${usd(price.minimumMinor)} per call`;
  }
  return `${usd(price.minimumMinor)} to ${usd(price.maximumMinor)} per call`;
}

function withInvocationIdentity(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  if (
    schema.type !== "object" ||
    (properties !== undefined &&
      (typeof properties !== "object" || properties === null || Array.isArray(properties)))
  ) {
    throw new Error("offer input schema must be an object before MCP projection");
  }
  const current = (properties ?? {}) as Record<string, unknown>;
  const reserved = [IDEMPOTENCY_ARGUMENT, SOURCE_ARGUMENT, CAMPAIGN_ARGUMENT];
  const conflict = reserved.find((name) => name in current);
  if (conflict !== undefined) {
    throw new Error(`offer input schema reserves ${conflict} for MCP invocation metadata`);
  }
  return {
    ...schema,
    properties: {
      ...current,
      [IDEMPOTENCY_ARGUMENT]: {
        type: "string",
        minLength: 16,
        maxLength: 128,
        description:
          "Required caller-owned purchase identity. Save before payment and reuse with unchanged input to recover an uncertain response. A different key authorizes another purchase.",
      },
      [SOURCE_ARGUMENT]: {
        type: "string",
        pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
        description:
          "Optional self-reported source attribution. Reporting only; never affects payment or execution.",
      },
      [CAMPAIGN_ARGUMENT]: {
        type: "string",
        pattern: "^[a-z0-9][a-z0-9._-]{0,127}$",
        description: `Optional self-reported campaign attribution; requires ${SOURCE_ARGUMENT}.`,
      },
    },
    required: [...new Set([...(Array.isArray(schema.required) ? schema.required : []), IDEMPOTENCY_ARGUMENT])],
  };
}

async function deriveTools(
  client: AuscaClient,
  origin: string,
  options: { paying: boolean },
): Promise<DerivedTool[]> {
  const { offers, document } = await client.catalog();
  const operations = ((document.contract as Record<string, unknown> | undefined)?.operations ??
    []) as { method: string; path: string; operation_id: string }[];
  const projected = ((document.mcp as Record<string, unknown> | undefined)?.tools ?? []) as {
    name: string;
    operation_id: string;
  }[];

  const tools: DerivedTool[] = [];
  for (const entry of offers) {
    const offer = await client.offer(entry.offer_id as string);
    const operation = operations.find(
      (candidate) => candidate.method === offer.routeMethod && candidate.path === offer.routePath,
    );
    const name =
      projected.find((tool) => tool.operation_id === operation?.operation_id)?.name ??
      `ausca_${offer.offerId.replace(/[^a-z0-9]+/gi, "_")}`;
    let inputSchema: Record<string, unknown> = { ...PERMISSIVE_INPUT };
    try {
      const response = await fetch(`${origin}${offer.inputSchemaPath}`);
      if (response.ok) {
        inputSchema = (await response.json()) as Record<string, unknown>;
      }
    } catch {
      // The service owns validation; a permissive schema defers to it.
    }
    const paymentNote = options.paying
      ? "Paid automatically within the configured AUSCA_MAX_PAYMENT_USD cap."
      : "Requires AUSCA_PRIVATE_KEY and AUSCA_MAX_PAYMENT_USD in this server's environment.";
    tools.push({
      name,
      offerId: offer.offerId,
      inputSchema: withInvocationIdentity(inputSchema),
      description: `${offer.description} Price: ${priceSummary(offer.price)}. ${paymentNote}`,
    });
  }

  tools.push({
    name: "ausca_catalog",
    description: "List the active Ausca offers with prices, routes, and revisions.",
    inputSchema: { type: "object", additionalProperties: false },
  });
  tools.push({
    name: "ausca_price",
    description: "Read the published price policy of one Ausca offer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["offer_id"],
      properties: { offer_id: { type: "string" } },
    },
  });
  tools.push({
    name: "ausca_commit_artifact",
    description:
      "Commit input bytes through Ausca's keyless temporary ingress; returns the immutable commitment required by document and media offers.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["data_base64", "media_type"],
      properties: {
        data_base64: { type: "string" },
        media_type: { type: "string" },
        [IDEMPOTENCY_ARGUMENT]: {
          type: "string",
          minLength: 16,
          maxLength: 128,
          description:
            "Optional caller-owned identity for recovery. Reuse it only for the same bytes and media type; omit it for a new temporary commitment.",
        },
      },
    },
  });
  return tools;
}

function textResult(value: unknown, isError = false): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function decodeArtifactBytes(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > MAX_BASE64_LENGTH ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    throw new Error("data_base64 must be bounded canonical standard base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error("data_base64 must be bounded canonical standard base64");
  }
  return new Uint8Array(decoded);
}

export async function buildMcpServer(env: Environment): Promise<Server> {
  const client = clientFromEnvironment(env);
  const paying = paymentFromEnvironment(env) !== null;
  const origin = env.AUSCA_ORIGIN ?? "https://ausca.com";
  const tools = await deriveTools(client, origin, { paying });
  const version = packageMetadata.version;

  const server = new Server({ name: "ausca", version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (!tool) {
        return textResult({ error: `unknown tool ${request.params.name}` }, true);
      }
      if (tool.name === "ausca_catalog") {
        const { offers } = await client.catalog();
        return textResult(
          offers.map((offer) => ({
            offer_id: offer.offer_id,
            title: offer.title,
            route: offer.route,
            price: offer.price,
            revision: offer.revision,
          })),
        );
      }
      if (tool.name === "ausca_price") {
        return textResult(await client.price(args.offer_id as string));
      }
      if (tool.name === "ausca_commit_artifact") {
        const idempotencyKey = args[IDEMPOTENCY_ARGUMENT];
        if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
          throw new Error(`${IDEMPOTENCY_ARGUMENT} must be a string`);
        }
        return textResult(
          await client.commit(
            decodeArtifactBytes(args.data_base64),
            args.media_type as string,
            { ...(idempotencyKey === undefined ? {} : { idempotencyKey }) },
          ),
        );
      }
      if (!paying) {
        return textResult(
          {
            error:
              "this server cannot pay: set AUSCA_PRIVATE_KEY and AUSCA_MAX_PAYMENT_USD in its environment",
          },
          true,
        );
      }
      const {
        [IDEMPOTENCY_ARGUMENT]: idempotencyKey,
        [SOURCE_ARGUMENT]: source,
        [CAMPAIGN_ARGUMENT]: campaign,
        ...input
      } = args;
      if (typeof idempotencyKey !== "string") {
        throw new Error(`${IDEMPOTENCY_ARGUMENT} is required before payment. Reuse the same key and input to recover; a new key buys again.`);
      }
      if (source !== undefined && typeof source !== "string") {
        throw new Error(`${SOURCE_ARGUMENT} must be a string`);
      }
      if (campaign !== undefined && typeof campaign !== "string") {
        throw new Error(`${CAMPAIGN_ARGUMENT} must be a string`);
      }
      if (campaign !== undefined && source === undefined) {
        throw new Error(`${CAMPAIGN_ARGUMENT} requires ${SOURCE_ARGUMENT}`);
      }
      return textResult(
        await client.invoke(tool.offerId as string, input, {
          idempotencyKey,
          ...(source === undefined
            ? {}
            : { attribution: { source, ...(campaign === undefined ? {} : { campaign }) } }),
        }),
      );
    } catch (error) {
      return textResult({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  });

  return server;
}

export async function serveMcp(env: Environment): Promise<void> {
  const server = await buildMcpServer(env);
  await server.connect(new StdioServerTransport());
  // The transport owns the process lifetime from here.
  await new Promise(() => {});
}
