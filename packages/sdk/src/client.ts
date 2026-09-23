import {
  auscaArtifactStore,
  type ArtifactCommitment,
  type ArtifactCommitOptions,
  type ArtifactStore,
} from "./artifacts.js";
import {
  localKeyAuthority,
  type LocalKeyAuthorityOptions,
  type PaymentAuthority,
  type PaymentReceipt,
} from "./payment.js";
import { sha256Hex } from "./digest.js";

// The Ausca client: catalog-bound paid invocations. It resolves an offer's
// immutable binding from the live catalog, builds the exact envelope with a
// caller-stable idempotency key, and pays the offer's own payable resource
// through the configured payment authority. Rails are authority
// implementations, never client concerns.

export const ORIGIN = "https://ausca.com";
export const CATALOG_URL = `${ORIGIN}/catalog.json`;
export const SKILL_URL = `${ORIGIN}/SKILL.md`;

export class AuscaError extends Error {}
export class CatalogError extends AuscaError {}
export class OfferNotActiveError extends AuscaError {}
export interface InvocationIdentity {
  readonly offerId: string;
  readonly idempotencyKey: string;
}

/** Optional caller-supplied acquisition context. It never affects payment or execution. */
export interface InvocationAttribution {
  readonly source: string;
  readonly campaign?: string;
}

/** The response is uncertain, not permission to make another purchase. */
export class InvocationUncertainError extends AuscaError {
  constructor(readonly identity: InvocationIdentity) {
    super(`Invocation response is uncertain. Recover ${identity.offerId} with the same input and idempotencyKey ${identity.idempotencyKey}; do not create a new purchase.`);
  }
}
/** The payable resource answered with a typed business refusal. */
export class RefusalError extends AuscaError {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly identity?: InvocationIdentity,
  ) {
    super(message);
  }
}

/** One price option of an input_choice offer. */
export interface PriceOption {
  readonly amountMinor: number;
  readonly value: unknown;
}

/** The published price policy of one active offer. */
export interface Price {
  readonly currency: string;
  readonly model: string;
  readonly minimumMinor: number;
  readonly maximumMinor: number;
  readonly options?: readonly PriceOption[];
  readonly inputField?: string;
}

/** One active offer's immutable binding from the live catalog. */
export interface Offer {
  readonly offerId: string;
  readonly title: string;
  readonly description: string;
  readonly revision: string;
  readonly revisionDigest: string;
  readonly inputSchemaDigest: string;
  readonly inputSchemaPath: string;
  readonly outputSchemaDigest: string;
  readonly outputSchemaPath: string;
  readonly pricingPolicyDigest: string;
  readonly routeMethod: string;
  readonly routePath: string;
  readonly price: Price;
  readonly artifactInputMode: string;
}

export interface InvocationResult {
  /** Parsed JSON result when the response is JSON, else the raw text. */
  readonly result: unknown;
  /** Settlement proof, or null when the call needed no payment. */
  readonly payment: PaymentReceipt | null;
  readonly status: number;
  readonly identity: InvocationIdentity;
}

/** Safe, opt-in diagnostics: no input, credentials, capabilities, or raw headers. */
export interface InvocationTrace extends InvocationIdentity {
  readonly phase: "request" | "response" | "uncertain";
  readonly requestDigest: string;
  readonly offerRevisionDigest: string;
  readonly elapsedMs: number;
  readonly status?: number;
}

export interface InvocationEnvelopeOptions {
  readonly idempotencyKey?: string;
  readonly attribution?: InvocationAttribution;
}

export interface InvokeOptions extends InvocationEnvelopeOptions {
  /** Persist identity on the request event before allowing payment to proceed. */
  readonly onTrace?: (event: InvocationTrace) => void | Promise<void>;
}

/** Short-lived download access for one artifact the service holds. */
export interface ArtifactAccess extends ArtifactCommitment {
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly downloadUrl: string;
  readonly expiresAt: string;
}

export interface Catalog {
  readonly offers: readonly Record<string, unknown>[];
  readonly document: Record<string, unknown>;
}

export interface AuscaClientOptions {
  /** The payment authority that pays 402 challenges within policy. */
  readonly payment: PaymentAuthority;
  /** Optional custom store for artifact-backed inputs; Ausca ingress is the default. */
  readonly artifacts?: ArtifactStore;
  /** Service origin override, for tests. */
  readonly origin?: string;
  /** Base fetch implementation, for tests and custom transports. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface WithLocalKeyOptions extends LocalKeyAuthorityOptions {
  readonly artifacts?: ArtifactStore;
  readonly origin?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class AuscaClient {
  private readonly origin: string;
  private readonly baseFetch: typeof globalThis.fetch;
  private readonly payment: PaymentAuthority;
  private readonly artifacts: ArtifactStore;
  private catalogDocument: Catalog | null = null;

  constructor(options: AuscaClientOptions) {
    this.origin = (options.origin ?? ORIGIN).replace(/\/$/, "");
    this.baseFetch = options.fetch ?? globalThis.fetch;
    this.payment = options.payment;
    this.artifacts = options.artifacts ?? auscaArtifactStore({ origin: this.origin, fetch: this.baseFetch });
  }

  /** Sugar for the default rail: a local signing key under a hard USD cap. */
  static withLocalKey(options: WithLocalKeyOptions): AuscaClient {
    const { artifacts, origin, fetch, ...authority } = options;
    return new AuscaClient({
      payment: localKeyAuthority(authority),
      artifacts,
      origin,
      fetch,
    });
  }

  /** The live immutable catalog, fetched once and cached. */
  async catalog(options?: { refresh?: boolean }): Promise<Catalog> {
    if (this.catalogDocument === null || options?.refresh) {
      const response = await this.baseFetch(`${this.origin}/catalog.json`);
      if (!response.ok) {
        throw new CatalogError(`catalog fetch answered ${response.status}`);
      }
      const document = (await response.json()) as Record<string, unknown>;
      const offers = document.offers;
      if (!Array.isArray(offers)) {
        throw new CatalogError("catalog document carries no offers");
      }
      this.catalogDocument = { offers, document };
    }
    return this.catalogDocument;
  }

  /** Resolve one active offer's immutable binding. */
  async offer(offerId: string): Promise<Offer> {
    const { offers } = await this.catalog();
    const entry = offers.find((candidate) => candidate.offer_id === offerId) as
      | Record<string, never>
      | undefined;
    if (!entry) {
      throw new OfferNotActiveError(`offer ${offerId} is not active in the catalog`);
    }
    const price = entry.price as Record<string, never>;
    return {
      offerId: entry.offer_id,
      title: entry.title,
      description: entry.description,
      revision: entry.revision,
      revisionDigest: entry.revision_digest,
      inputSchemaDigest: (entry.input_schema as { digest: string }).digest,
      inputSchemaPath: (entry.input_schema as { public_path: string }).public_path,
      outputSchemaDigest: (entry.output_schema as { digest: string }).digest,
      outputSchemaPath: (entry.output_schema as { public_path: string }).public_path,
      pricingPolicyDigest: price.policy_digest,
      routeMethod: (entry.route as { method: string }).method,
      routePath: (entry.route as { path: string }).path,
      artifactInputMode: (entry.artifact as { input_mode: string }).input_mode,
      price: {
        currency: price.currency,
        model: price.model,
        minimumMinor: price.minimum_minor,
        maximumMinor: price.maximum_minor,
        inputField: price.input_field,
        options: (price.options as { amount_minor: number; value: unknown }[] | undefined)?.map(
          (option) => ({ amountMinor: option.amount_minor, value: option.value }),
        ),
      },
    };
  }

  /** The published price policy of one offer. No wallet is needed. */
  async price(offerId: string): Promise<Price> {
    return (await this.offer(offerId)).price;
  }

  /**
   * The exact invocation envelope for one offer. A fresh key starts one
   * intentional purchase; supply the same explicit key to recover or retry
   * that purchase without minting another.
   */
  async envelope(
    offer: Offer,
    input: unknown,
    idempotencyKey?: string,
    attribution?: InvocationAttribution,
  ): Promise<Record<string, unknown>> {
    if (idempotencyKey === undefined) {
      idempotencyKey = `ausca-${crypto.randomUUID()}`;
    }
    const keyBytes = new TextEncoder().encode(idempotencyKey).length;
    if (
      keyBytes < 16 ||
      keyBytes > 128 ||
      idempotencyKey.trim() !== idempotencyKey ||
      /[\u0000-\u001f\u007f]/u.test(idempotencyKey)
    ) {
      throw new AuscaError("idempotencyKey must be 16 to 128 clean UTF-8 bytes");
    }
    if (attribution !== undefined) validateAttribution(attribution);
    return {
      offer_id: offer.offerId,
      offer_revision: offer.revision,
      offer_revision_digest: offer.revisionDigest,
      input_schema_digest: offer.inputSchemaDigest,
      output_schema_digest: offer.outputSchemaDigest,
      input,
      idempotency_key: idempotencyKey,
      ...(attribution === undefined ? {} : { attribution }),
    };
  }

  /** Run one paid invocation: probe, pay within policy, return proof. */
  async invoke(
    offerId: string,
    input: unknown,
    options?: InvokeOptions,
  ): Promise<InvocationResult> {
    const offer = await this.offer(offerId);
    const body = await this.envelope(
      offer,
      input,
      options?.idempotencyKey,
      options?.attribution,
    );
    const identity = { offerId, idempotencyKey: body.idempotency_key as string };
    const serialized = JSON.stringify(body);
    const requestDigest = `sha256:${await sha256Hex(new TextEncoder().encode(serialized))}`;
    const started = performance.now();
    const trace = (phase: InvocationTrace["phase"], status?: number) => options?.onTrace?.({
      ...identity, phase, requestDigest, offerRevisionDigest: offer.revisionDigest,
      elapsedMs: performance.now() - started, ...(status === undefined ? {} : { status }),
    });
    // A caller may refuse or fail to persist identity here. No payment has happened.
    await trace("request");
    let response: Response;
    let text: string;
    let transportFailed = false;
    let responseMayHaveExecuted = false;
    try {
      const send = this.payment.wrapFetch(async (request, init) => {
        const outgoing = new Request(request, init);
        if (await outgoing.clone().text() !== serialized) {
          throw new AuscaError("payment authority changed the bound invocation bytes");
        }
        let result: Response;
        try {
          result = await this.baseFetch(outgoing);
        } catch (error) {
          transportFailed = true;
          throw error;
        }
        responseMayHaveExecuted ||= result.ok || result.status >= 500;
        // Diagnostics after an effect must never turn success into a retry.
        await Promise.resolve().then(() => trace("response", result.status)).catch(() => {});
        return result;
      });
      response = await send(`${this.origin}${offer.routePath}`, {
        method: offer.routeMethod,
        headers: { "content-type": "application/json" },
        body: serialized,
      });
      text = await response.text();
    } catch (error) {
      // A policy refusal before payment (for example, a spend cap) is not an
      // uncertain purchase. Preserve its useful diagnostic for the caller.
      if (!transportFailed && !responseMayHaveExecuted) throw error;
      await Promise.resolve().then(() => trace("uncertain")).catch(() => {});
      throw new InvocationUncertainError(identity);
    }
    let result: unknown = text;
    try {
      result = JSON.parse(text);
    } catch {
      // Non-JSON bodies are returned as text.
    }
    if (!response.ok) {
      throw new RefusalError(
        `payable resource ${offer.routePath} answered ${response.status}; purchase key ${identity.idempotencyKey}. Read the typed body; recover with the same input and key.`,
        response.status,
        result,
        identity,
      );
    }
    try {
      return { result, payment: this.payment.receipt(response), status: response.status, identity };
    } catch {
      await Promise.resolve().then(() => trace("uncertain")).catch(() => {});
      throw new InvocationUncertainError(identity);
    }
  }

  /** Inspect the HTTP challenge without ever invoking the payment authority. */
  async probe(
    offerId: string,
    input: unknown,
    options?: InvocationEnvelopeOptions,
  ): Promise<Response> {
    const offer = await this.offer(offerId);
    const body = await this.envelope(
      offer,
      input,
      options?.idempotencyKey,
      options?.attribution,
    );
    return this.baseFetch(`${this.origin}${offer.routePath}`, {
      method: offer.routeMethod,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Read authoritative durable invocation state without a new purchase. */
  async invocation(invocationId: string): Promise<Record<string, unknown>> {
    const response = await this.baseFetch(
      `${this.origin}/v1/invocations/${encodeURIComponent(invocationId)}`,
    );
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || body === null) {
      throw new AuscaError(`invocation read answered ${response.status}`);
    }
    return body;
  }

  /** Commit input bytes through the configured artifact store. */
  async commit(
    bytes: Uint8Array,
    mediaType: string,
    options?: ArtifactCommitOptions,
  ): Promise<ArtifactCommitment> {
    return this.artifacts.commit(bytes, mediaType, options);
  }

  /**
   * Mint a 60-second download URL for an artifact this service holds, such
   * as an invocation's `output_artifact`. Verify downloaded bytes against
   * `contentDigest`; the URL itself is not proof of content.
   */
  async artifactAccess(artifactRef: string, idempotencyKey?: string): Promise<ArtifactAccess> {
    const response = await this.baseFetch(
      `${this.origin}/v1/artifacts/${encodeURIComponent(artifactRef)}/access`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey ?? `ausca-${crypto.randomUUID()}` },
      },
    );
    const body = (await response.json().catch(() => null)) as
      | { status?: string; artifact?: Record<string, unknown> }
      | null;
    if (!response.ok || body?.status !== "ready" || body.artifact === undefined) {
      throw new AuscaError(`artifact access answered ${response.status}`);
    }
    const artifact = body.artifact;
    return {
      artifactRef: artifact.artifact_ref as string,
      contentDigest: artifact.content_digest as string,
      mediaType: artifact.media_type as string,
      sizeBytes: artifact.size_bytes as number,
      createdAt: artifact.created_at as string,
      downloadUrl: artifact.download_url as string,
      expiresAt: artifact.expires_at as string,
    };
  }
}

const ATTRIBUTION_LABEL = /^[a-z0-9][a-z0-9._-]*$/u;

function validateAttribution(attribution: InvocationAttribution): void {
  if (
    attribution.source.length > 64 ||
    !ATTRIBUTION_LABEL.test(attribution.source) ||
    (attribution.campaign !== undefined &&
      (attribution.campaign.length > 128 || !ATTRIBUTION_LABEL.test(attribution.campaign)))
  ) {
    throw new AuscaError(
      "attribution source and campaign must be bounded lowercase labels",
    );
  }
}
