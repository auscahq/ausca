import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  clientFromEnvironment,
  type Environment,
} from "./env.js";
import { serveMcp } from "./mcp.js";

// The front-door verbs. Configuration is environment only: a signing key and
// a mandatory per-call USD cap for paying verbs, nothing else. Artifact
// commits are keyless. Output is JSON on stdout.

export interface CliEnvironment {
  readonly env: Environment;
  write(line: string): void;
  writeError(line: string): void;
  readStdin(): Promise<string>;
}

const USAGE = `ausca: metered agent infrastructure services, paid per call

  ausca catalog                    active offers, prices, routes
  ausca price <offer-id> [--json]  published price and immutable binding
  ausca invoke <offer-id> [input] --idempotency-key <key> [--source <source>] [--campaign <campaign>]
                                     paid invocation; input JSON, file, @file, or stdin
  ausca commit <file> [--idempotency-key <key>]
                                     artifact commitment for document and media offers
  ausca mcp                        local MCP server over stdio

Environment: AUSCA_PRIVATE_KEY and AUSCA_MAX_PAYMENT_USD pay invocations;
AUSCA_NETWORK overrides the payment network; AUSCA_ORIGIN overrides the service.
Save one unique purchase key (16–128 bytes) before invoking. After an uncertain
response, reuse that key and the same input; a new key authorizes a new purchase.`;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  csv: "text/csv",
  json: "application/json",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  flac: "audio/flac",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

export function mediaTypeFor(name: string): string {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return MEDIA_TYPES[extension] ?? "application/octet-stream";
}

function invocationArguments(rest: readonly string[]): {
  offerId: string;
  inputArgument?: string;
  idempotencyKey?: string;
  source?: string;
  campaign?: string;
} {
  const [offerId, ...arguments_] = rest;
  if (!offerId) throw new Error("usage: ausca invoke <offer-id> [input] [--idempotency-key <key>]");
  let inputArgument: string | undefined;
  let idempotencyKey: string | undefined;
  let source: string | undefined;
  let campaign: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--idempotency-key") {
      if (idempotencyKey !== undefined || !arguments_[index + 1]) {
        throw new Error("--idempotency-key requires one value");
      }
      idempotencyKey = arguments_[index + 1];
      index += 1;
    } else if (argument === "--source") {
      if (source !== undefined || !arguments_[index + 1]) {
        throw new Error("--source requires one value");
      }
      source = arguments_[index + 1];
      index += 1;
    } else if (argument === "--campaign") {
      if (campaign !== undefined || !arguments_[index + 1]) {
        throw new Error("--campaign requires one value");
      }
      campaign = arguments_[index + 1];
      index += 1;
    } else if (inputArgument === undefined) {
      inputArgument = argument;
    } else {
      throw new Error(`unexpected invoke argument ${argument}`);
    }
  }
  if (campaign !== undefined && source === undefined) {
    throw new Error("--campaign requires --source");
  }
  return { offerId, inputArgument, idempotencyKey, source, campaign };
}

function commitArguments(rest: readonly string[]): {
  file: string;
  idempotencyKey?: string;
} {
  let file: string | undefined;
  let idempotencyKey: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--idempotency-key") {
      if (idempotencyKey !== undefined || !rest[index + 1]) {
        throw new Error("--idempotency-key requires one value");
      }
      idempotencyKey = rest[index + 1];
      index += 1;
    } else if (file === undefined) {
      file = argument;
    } else {
      throw new Error(`unexpected commit argument ${argument}`);
    }
  }
  if (!file) {
    throw new Error("usage: ausca commit <file> [--idempotency-key <key>]");
  }
  return { file, idempotencyKey };
}

async function resolveInput(argument: string | undefined, environment: CliEnvironment): Promise<unknown> {
  let text: string;
  if (argument === undefined || argument === "-") {
    text = await environment.readStdin();
  } else if (argument.startsWith("@")) {
    text = await readFile(argument.slice(1), "utf8");
  } else {
    try {
      return JSON.parse(argument);
    } catch {
      text = await readFile(argument, "utf8").catch(() => {
        throw new Error("input must be JSON, a readable file path, @file, or - for stdin");
      });
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invocation input must be valid JSON");
  }
}

export async function runCli(argv: readonly string[], environment: CliEnvironment): Promise<number> {
  const [verb, ...rest] = argv;
  try {
    switch (verb) {
      case "catalog": {
        const client = clientFromEnvironment(environment.env);
        const { offers } = await client.catalog();
        const listing = offers.map((offer) => ({
          offer_id: offer.offer_id,
          title: offer.title,
          route: offer.route,
          price: offer.price,
          revision: offer.revision,
        }));
        environment.write(JSON.stringify(listing, null, 2));
        return 0;
      }
      case "price": {
        const arguments_ = rest.filter((value) => value !== "--json");
        const [offerId] = arguments_;
        if (!offerId || arguments_.length !== 1 || offerId.startsWith("--")) {
          throw new Error("usage: ausca price <offer-id> [--json]");
        }
        const client = clientFromEnvironment(environment.env);
        const offer = await client.offer(offerId);
        environment.write(JSON.stringify({
          ...offer.price,
          offer_id: offer.offerId,
          offer_revision: offer.revision,
          offer_revision_digest: offer.revisionDigest,
          pricing_policy_digest: offer.pricingPolicyDigest,
          input_schema_digest: offer.inputSchemaDigest,
          output_schema_digest: offer.outputSchemaDigest,
          route: { method: offer.routeMethod, path: offer.routePath },
        }, null, 2));
        return 0;
      }
      case "invoke": {
        const { offerId, inputArgument, idempotencyKey, source, campaign } = invocationArguments(rest);
        const client = clientFromEnvironment(environment.env, { requirePayment: true });
        if (idempotencyKey === undefined) {
          throw new Error("paid invocations require --idempotency-key <key> (16–128 bytes). Save it before paying; reuse it with the same input to recover. A new key buys again.");
        }
        const input = await resolveInput(inputArgument, environment);
        const outcome = await client.invoke(offerId, input, {
          idempotencyKey,
          ...(source === undefined
            ? {}
            : { attribution: { source, ...(campaign === undefined ? {} : { campaign }) } }),
        });
        if (outcome.result && typeof outcome.result === "object" && "resource_access" in outcome.result) {
          environment.writeError("This result contains private resource capabilities. Store it securely; do not publish raw output.");
        }
        environment.write(JSON.stringify(outcome, null, 2));
        return 0;
      }
      case "commit": {
        const { file, idempotencyKey } = commitArguments(rest);
        const client = clientFromEnvironment(environment.env);
        const bytes = new Uint8Array(await readFile(file));
        const commitment = await client.commit(bytes, mediaTypeFor(file), {
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
        environment.write(JSON.stringify(commitment, null, 2));
        return 0;
      }
      case "mcp": {
        await serveMcp(environment.env);
        return 0;
      }
      case undefined:
      case "help":
      case "--help": {
        environment.write(USAGE);
        return verb === undefined ? 1 : 0;
      }
      default:
        throw new Error(`unknown verb ${verb}; run ausca help`);
    }
  } catch (error) {
    environment.writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function processEnvironment(): CliEnvironment {
  return {
    env: process.env,
    write: (line) => process.stdout.write(`${line}\n`),
    writeError: (line) => process.stderr.write(`${line}\n`),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
