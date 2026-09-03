import { base64Encode, sha256Hex } from "./digest.js";

// Artifact-backed offers take an immutable input commitment instead of raw
// bytes. This port turns bytes into that commitment; the hosted Runx store
// is the day-one implementation. A future ingestion rail slots in behind
// the same interface with no client API change.

/** The immutable input commitment an artifact-backed offer requires. */
export interface ArtifactCommitment {
  readonly artifactRef: string;
  readonly contentDigest: string;
  readonly mediaType: string;
}

export interface ArtifactStore {
  /** Store bytes and return the commitment the invocation input carries. */
  commit(bytes: Uint8Array, mediaType: string): Promise<ArtifactCommitment>;
}

export class ArtifactError extends Error {}

export interface RunxArtifactStoreOptions {
  /** Self-serve Runx bearer token with artifacts:read and artifacts:write. */
  readonly token: string;
  /** Hosted API origin. Defaults to the production Runx API. */
  readonly origin?: string;
  /** Execution principal receiving the handoff copy. Defaults to "ausca". */
  readonly targetPrincipalId?: string;
  /** Bounded context identifier recorded with each operation. */
  readonly runContext?: string;
  /** Base fetch implementation, for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

export const RUNX_ORIGIN = "https://api.runx.ai";

/**
 * Commits bytes through the hosted Runx artifact boundary: one
 * digest-idempotent allocation, then one explicit handoff copy to the
 * execution principal. Both idempotency keys derive from the content
 * digest, so an uncertain retry can never duplicate storage or handoff.
 */
export function runxArtifactStore(options: RunxArtifactStoreOptions): ArtifactStore {
  const origin = (options.origin ?? RUNX_ORIGIN).replace(/\/$/, "");
  const baseFetch = options.fetch ?? globalThis.fetch;
  const runContext = options.runContext ?? "ausca-sdk";
  const target = options.targetPrincipalId ?? "ausca";

  async function operation(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await baseFetch(`${origin}/v1/artifact-operations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let decoded: unknown = null;
    try {
      decoded = JSON.parse(text);
    } catch {
      // Non-JSON errors surface as raw text below.
    }
    if (!response.ok) {
      throw new ArtifactError(
        `artifact operation ${body.operation} answered ${response.status}: ${text.slice(0, 512)}`,
      );
    }
    return decoded as Record<string, unknown>;
  }

  return {
    async commit(bytes, mediaType) {
      if (bytes.length === 0) {
        throw new ArtifactError("cannot commit an empty artifact");
      }
      const hex = await sha256Hex(bytes);
      const contentDigest = `sha256:${hex}`;
      const allocated = await operation({
        operation: "artifact.allocate",
        run_id: runContext,
        input: {
          idempotency_key: `ausca-artifact-${hex.slice(0, 32)}`,
          data_base64: base64Encode(bytes),
          content_digest: contentDigest,
          media_type: mediaType,
        },
      });
      const evidence = allocated.result as Record<string, unknown> | undefined;
      const artifactRef = evidence?.artifact_ref;
      if (typeof artifactRef !== "string") {
        throw new ArtifactError("allocation returned no artifact reference");
      }
      await operation({
        operation: "artifact.handoff",
        run_id: runContext,
        input: {
          idempotency_key: `ausca-handoff-${hex.slice(0, 32)}`,
          source_artifact_ref: artifactRef,
          target_principal_id: target,
        },
      });
      return { artifactRef, contentDigest, mediaType };
    },
  };
}
