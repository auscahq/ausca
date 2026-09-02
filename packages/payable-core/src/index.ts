import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import type { LocalAccount } from "viem";

// The shared kernel behind every framework adapter: a fetch that answers
// HTTP 402 with an x402 v2 payment, under an explicit per-call USD cap. All
// payment construction and signing stays in the official x402 client
// libraries; this module only configures them and shapes the result.

export interface PayableFetchOptions {
  /** The signing account that pays. Never leaves the process. */
  readonly account: LocalAccount;
  /**
   * CAIP-2 network the account pays on. Defaults to Base mainnet. Use
   * "eip155:*" to accept any EVM network the resource offers.
   */
  readonly network?: string;
  /**
   * Hard per-call USD cap, enforced by the x402 client's spend controls on
   * recognized stablecoin assets before anything is signed. Required so a
   * tool can never spend more per call than its author declared.
   */
  readonly maxPaymentUsd: number;
  /** Base fetch implementation, for tests and custom transports. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Settlement details decoded from a paid response's PAYMENT-RESPONSE header. */
export interface PaymentReceipt {
  readonly success: boolean;
  readonly network?: string;
  readonly transaction?: string;
  readonly payer?: string;
}

export function createPayableFetch(options: PayableFetchOptions): typeof globalThis.fetch {
  if (!Number.isFinite(options.maxPaymentUsd) || options.maxPaymentUsd <= 0) {
    throw new Error("maxPaymentUsd must be a positive number");
  }
  return wrapFetchWithPaymentFromConfig(options.fetch ?? globalThis.fetch, {
    schemes: [
      {
        network: (options.network ?? "eip155:8453") as never,
        client: new ExactEvmScheme(options.account),
      },
    ],
    spendControls: { maxAmountPerPayment: `$${options.maxPaymentUsd}` },
  });
}

/**
 * Decodes the settlement proof from a paid response, or null when the
 * response required no payment.
 */
export function paymentReceipt(response: Response): PaymentReceipt | null {
  const header = response.headers.get("PAYMENT-RESPONSE");
  if (!header) {
    return null;
  }
  const decoded = decodePaymentResponseHeader(header) as Record<string, unknown>;
  return {
    success: decoded.success === true,
    network: typeof decoded.network === "string" ? decoded.network : undefined,
    transaction: typeof decoded.transaction === "string" ? decoded.transaction : undefined,
    payer: typeof decoded.payer === "string" ? decoded.payer : undefined,
  };
}

export interface PayableCallOptions extends PayableFetchOptions {
  /** The payable resource URL. Works against any x402 v2 resource. */
  readonly url: string;
  /** HTTP method of the payable resource. */
  readonly method?: "GET" | "POST";
  /** Extra request headers. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface PayableCallResult {
  /** Parsed JSON body when the response is JSON, else the raw text. */
  readonly result: unknown;
  /** Settlement proof, or null when the call needed no payment. */
  readonly payment: PaymentReceipt | null;
  readonly status: number;
}

/**
 * One paid call: request, pay the 402 within the cap, and return the parsed
 * result with its settlement proof.
 */
export async function payableCall(
  options: PayableCallOptions,
  body?: unknown,
): Promise<PayableCallResult> {
  const method = options.method ?? "POST";
  const payableFetch = createPayableFetch(options);
  const response = await payableFetch(options.url, {
    method,
    headers: { "content-type": "application/json", ...options.headers },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let result: unknown = text;
  try {
    result = JSON.parse(text);
  } catch {
    // Non-JSON bodies are returned as text.
  }
  if (!response.ok) {
    throw new Error(
      `payable resource ${options.url} answered ${response.status}: ${text.slice(0, 512)}`,
    );
  }
  return { result, payment: paymentReceipt(response), status: response.status };
}
