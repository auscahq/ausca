import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  artifactsFromEnvironment,
  clientFromEnvironment,
  type Environment,
} from "./env.js";
import { serveMcp } from "./mcp.js";

// The front-door verbs. Configuration is environment only: a signing key and
// a mandatory per-call USD cap for paying verbs, a Runx token for artifact
// commits, nothing else. Output is JSON on stdout.

export interface CliEnvironment {
  readonly env: Environment;
  write(line: string): void;
  writeError(line: string): void;
  readStdin(): Promise<string>;
}

const USAGE = `ausca: metered agent infrastructure services, paid per call

  ausca catalog                    active offers, prices, routes
  ausca price <offer-id>           published price policy
  ausca invoke <offer-id> [input]  paid invocation; input inline, @file, or stdin
  ausca commit <file>              artifact commitment for document and media offers
  ausca mcp                        local MCP server over stdio

Environment: AUSCA_PRIVATE_KEY and AUSCA_MAX_PAYMENT_USD pay invocations;
AUSCA_NETWORK overrides the payment network; RUNX_API_TOKEN enables commit.`;

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

async function resolveInput(argument: string | undefined, environment: CliEnvironment): Promise<unknown> {
  let text: string;
  if (argument === undefined || argument === "-") {
    text = await environment.readStdin();
  } else if (argument.startsWith("@")) {
    text = await readFile(argument.slice(1), "utf8");
  } else {
    text = argument;
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
        const [offerId] = rest;
        if (!offerId) {
          throw new Error("usage: ausca price <offer-id>");
        }
        const client = clientFromEnvironment(environment.env);
        environment.write(JSON.stringify(await client.price(offerId), null, 2));
        return 0;
      }
      case "invoke": {
        const [offerId, inputArgument] = rest;
        if (!offerId) {
          throw new Error("usage: ausca invoke <offer-id> [input]");
        }
        const client = clientFromEnvironment(environment.env, { requirePayment: true });
        const input = await resolveInput(inputArgument, environment);
        const outcome = await client.invoke(offerId, input);
        environment.write(JSON.stringify(outcome, null, 2));
        return 0;
      }
      case "commit": {
        const [file] = rest;
        if (!file) {
          throw new Error("usage: ausca commit <file>");
        }
        const store = artifactsFromEnvironment(environment.env);
        if (!store) {
          throw new Error("artifact commits need RUNX_API_TOKEN in the environment");
        }
        const bytes = new Uint8Array(await readFile(file));
        const commitment = await store.commit(bytes, mediaTypeFor(file));
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
