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
  commit(bytes: Uint8Array, mediaType: string): Promise<ArtifactCommitment>;
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

/**
 * Commits bytes through Ausca's keyless, temporary artifact ingress. The
 * idempotency key derives from the content digest and media type, so an
 * uncertain retry cannot create another logical artifact while the same bytes
 * may still be committed under a different truthful media type.
 */
export function auscaArtifactStore(options: AuscaArtifactStoreOptions = {}): ArtifactStore {
  const origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
  const baseFetch = options.fetch ?? globalThis.fetch;

  return {
    async commit(bytes, mediaType) {
      if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) {
        throw new ArtifactError(`artifact must contain 1 to ${MAX_ARTIFACT_BYTES} bytes`);
      }
      if (!mediaType || mediaType.trim() !== mediaType || mediaType.length > 200) {
        throw new ArtifactError("artifact media type is invalid");
      }
      const hex = await sha256Hex(bytes);
      const contentDigest = `sha256:${hex}`;
      const requestHex = await sha256Hex(
        new TextEncoder().encode(`${contentDigest}\n${mediaType}`),
      );
      const response = await baseFetch(`${origin}/v1/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          data_base64: base64Encode(bytes),
          content_digest: contentDigest,
          media_type: mediaType,
          idempotency_key: `ausca-artifact-${requestHex.slice(0, 32)}`,
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
      const evidence = decoded.artifact;
      const expectedRef = `runx:artifact:${contentDigest}`;
      if (evidence.artifact_ref !== expectedRef || evidence.content_digest !== contentDigest ||
          evidence.media_type !== mediaType || evidence.size_bytes !== bytes.length ||
          typeof evidence.created_at !== "string") {
        throw new ArtifactError("artifact ingress returned mismatched evidence");
      }
      return { artifactRef: expectedRef, contentDigest, mediaType };
    },
  };
}

function isExactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...fields].sort().join("\n");
}
