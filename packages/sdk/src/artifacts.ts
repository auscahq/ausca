import { base64Encode, sha256Hex } from "./digest.js";

// Artifact-backed offers take an immutable input commitment instead of raw
// bytes. This port turns bytes into that commitment; Ausca's keyless ingress
// is the default implementation and custom stores remain an explicit seam.

/** The immutable input commitment an artifact-backed offer requires. */
export interface ArtifactCommitment {
  readonly artifactRef: string;
  readonly contentDigest: string;
  readonly mediaType: string;
}

export interface ArtifactStore {
  /** Store bytes and return the commitment the invocation input carries. */
  commit(
    bytes: Uint8Array,
    mediaType: string,
    options?: ArtifactCommitOptions,
  ): Promise<ArtifactCommitment>;
}

export interface ArtifactCommitOptions {
  /**
   * Caller-owned identity for recovery after an uncertain response. Reuse it
   * only for the same bytes and media type; omit it for a new commitment.
   */
  readonly idempotencyKey?: string;
}

export class ArtifactError extends Error {}

export interface AuscaArtifactStoreOptions {
  /** Ausca service origin. Defaults to production. */
  readonly origin?: string;
  /** Base fetch implementation, for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_ORIGIN = "https://ausca.com";
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const ARTIFACT_REF_PATTERN = /^runx:artifact:sha256:[0-9a-f]{64}$/u;

/**
 * Commits bytes through Ausca's keyless, temporary artifact ingress. Every
 * call is a new temporary commitment unless the caller supplies the same
 * idempotency key to recover one uncertain upload. Content identity cannot be
 * the operation identity: an older commitment may already have expired.
 */
export function auscaArtifactStore(options: AuscaArtifactStoreOptions = {}): ArtifactStore {
  const origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
  const baseFetch = options.fetch ?? globalThis.fetch;

  return {
    async commit(bytes, mediaType, commitOptions) {
      if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) {
        throw new ArtifactError(`artifact must contain 1 to ${MAX_ARTIFACT_BYTES} bytes`);
      }
      if (!mediaType || mediaType.trim() !== mediaType || mediaType.length > 200) {
        throw new ArtifactError("artifact media type is invalid");
      }
      const hex = await sha256Hex(bytes);
      const contentDigest = `sha256:${hex}`;
      const idempotencyKey = artifactIdempotencyKey(commitOptions?.idempotencyKey);
      const response = await baseFetch(`${origin}/v1/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          data_base64: base64Encode(bytes),
          content_digest: contentDigest,
          media_type: mediaType,
          idempotency_key: idempotencyKey,
        }),
      });
      const text = await response.text();
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        throw new ArtifactError(`artifact ingress answered non-JSON: ${text.slice(0, 512)}`);
      }
      if (!response.ok) {
        throw new ArtifactError(`artifact ingress answered ${response.status}: ${text.slice(0, 512)}`);
      }
      if (!isExactObject(decoded, ["artifact", "status"]) || decoded.status !== "stored" ||
          !isExactObject(decoded.artifact, [
            "artifact_ref", "content_digest", "created_at", "media_type", "size_bytes",
          ])) {
        throw new ArtifactError("artifact ingress returned malformed evidence");
      }
      // The service mints its own storage identity, so the reference is the
      // one field the caller cannot derive. Everything the local bytes prove
      // is checked against them; the minted reference is checked for shape.
      const evidence = decoded.artifact;
      if (typeof evidence.artifact_ref !== "string" ||
          !ARTIFACT_REF_PATTERN.test(evidence.artifact_ref) ||
          evidence.content_digest !== contentDigest ||
          evidence.media_type !== mediaType || evidence.size_bytes !== bytes.length ||
          typeof evidence.created_at !== "string") {
        throw new ArtifactError("artifact ingress returned mismatched evidence");
      }
      return { artifactRef: evidence.artifact_ref, contentDigest, mediaType };
    },
  };
}

function artifactIdempotencyKey(value: string | undefined): string {
  const key = value ?? `ausca-artifact-${crypto.randomUUID()}`;
  const size = new TextEncoder().encode(key).length;
  if (
    size < 16 ||
    size > 128 ||
    key.trim() !== key ||
    /[\u0000-\u001f\u007f]/u.test(key)
  ) {
    throw new ArtifactError("artifact idempotencyKey must be 16 to 128 clean UTF-8 bytes");
  }
  return key;
}

function isExactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...fields].sort().join("\n");
}
