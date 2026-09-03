import { sha256HexOfJson } from "./digest.js";
import type { ArtifactCommitment, ArtifactStore } from "./artifacts.js";
import {
  localKeyAuthority,
  type LocalKeyAuthorityOptions,
  type PaymentAuthority,
  type PaymentReceipt,
} from "./payment.js";

// The Ausca client: catalog-bound paid invocations. It resolves an offer's
// immutable binding from the live catalog, builds the exact envelope with a
// deterministic idempotency key, and pays the offer's own payable resource
// through the configured payment authority. Rails are authority
// implementations, never client concerns.

export const ORIGIN = "https://ausca.com";
export const CATALOG_URL = `${ORIGIN}/catalog.json`;
export const SKILL_URL = `${ORIGIN}/SKILL.md`;

export class AuscaError extends Error {}
export class CatalogError extends AuscaError {}
export class OfferNotActiveError extends AuscaError {}
/** The payable resource answered with a typed business refusal. */
export class RefusalError extends AuscaError {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
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
  readonly canonicalizerVersion: string;
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
}

export interface Catalog {
  readonly offers: readonly Record<string, unknown>[];
  readonly document: Record<string, unknown>;
}

export interface AuscaClientOptions {
  /** The payment authority that pays 402 challenges within policy. */
  readonly payment: PaymentAuthority;
  /** Store for artifact-backed offer inputs; optional. */
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
  private readonly payableFetch: typeof globalThis.fetch;
  private readonly payment: PaymentAuthority;
  private readonly artifacts: ArtifactStore | undefined;
  private catalogDocument: Catalog | null = null;

  constructor(options: AuscaClientOptions) {
    this.origin = (options.origin ?? ORIGIN).replace(/\/$/, "");
    this.baseFetch = options.fetch ?? globalThis.fetch;
    this.payment = options.payment;
    this.payableFetch = options.payment.wrapFetch(this.baseFetch);
    this.artifacts = options.artifacts;
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
      canonicalizerVersion: entry.canonicalizer_version,
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
   * The exact invocation envelope for one offer. The default idempotency key
   * derives from the offer and input, so an uncertain retry of the same
   * request can never mint a second purchase.
   */
  async envelope(
    offer: Offer,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    if (idempotencyKey === undefined) {
      const hex = await sha256HexOfJson([offer.offerId, offer.revisionDigest, input]);
      idempotencyKey = `ausca-${hex.slice(0, 32)}`;
    }
    return {
      offer_id: offer.offerId,
      offer_revision: offer.revision,
      offer_revision_digest: offer.revisionDigest,
      input_schema_digest: offer.inputSchemaDigest,
      output_schema_digest: offer.outputSchemaDigest,
      canonicalizer_version: offer.canonicalizerVersion,
      input,
      idempotency_key: idempotencyKey,
    };
  }

  /** Run one paid invocation: probe, pay within policy, return proof. */
  async invoke(
    offerId: string,
    input: unknown,
    options?: { idempotencyKey?: string },
  ): Promise<InvocationResult> {
    const offer = await this.offer(offerId);
    const body = await this.envelope(offer, input, options?.idempotencyKey);
    const response = await this.payableFetch(`${this.origin}${offer.routePath}`, {
      method: offer.routeMethod,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let result: unknown = text;
    try {
      result = JSON.parse(text);
    } catch {
      // Non-JSON bodies are returned as text.
    }
    if (!response.ok) {
      throw new RefusalError(
        `payable resource ${offer.routePath} answered ${response.status}: ${text.slice(0, 512)}`,
        response.status,
        result,
      );
    }
    return { result, payment: this.payment.receipt(response), status: response.status };
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
  async commit(bytes: Uint8Array, mediaType: string): Promise<ArtifactCommitment> {
    if (!this.artifacts) {
      throw new AuscaError(
        "no artifact store is configured; artifact-backed offers need one",
      );
    }
    return this.artifacts.commit(bytes, mediaType);
  }
}
