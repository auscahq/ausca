import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";

import {
  createPayableFetch,
  paymentReceipt,
  type PaymentReceipt,
} from "@ausca-internal/payable";

// The payment boundary of the client. The core never sees a rail, a header
// name, a scheme, or a wallet: it calls a wrapped fetch and asks the
// authority to decode settlement evidence. Any rail that can answer an HTTP
// 402 challenge fits, including delegated executors that perform their own
// transport inside the wrapper. Cap enforcement lives inside the authority,
// before anything is signed.

export type { PaymentReceipt };

/** A payment rail the client can pay HTTP 402 challenges with. */
export interface PaymentAuthority {
  /** Rail identifiers this authority satisfies, e.g. ["x402-v2"]. */
  readonly rails: readonly string[];
  /** Wrap a fetch so 402 challenges it understands are paid within policy. */
  wrapFetch(base: typeof globalThis.fetch): typeof globalThis.fetch;
  /** Decode settlement evidence from a completed response, if present. */
  receipt(response: Response): PaymentReceipt | null;
}

/** The official x402 client configuration, passed through verbatim. */
export type X402AuthorityConfig = Parameters<typeof wrapFetchWithPaymentFromConfig>[1];

/**
 * An authority over the official x402 client libraries with any registered
 * scheme clients: local keys, hosted wallets, alternative networks. Spend
 * controls belong in the config; nothing is signed above them.
 */
export function x402Authority(config: X402AuthorityConfig): PaymentAuthority {
  return {
    rails: ["x402-v2"],
    wrapFetch: (base) => wrapFetchWithPaymentFromConfig(base, config),
    receipt: paymentReceipt,
  };
}

export interface LocalKeyAuthorityOptions {
  /** Hex private key of the paying account. Never leaves the process. */
  readonly privateKey?: `0x${string}`;
  /** Alternatively, a prepared signing account. */
  readonly account?: LocalAccount;
  /** Hard per-call USD cap, enforced before anything is signed. */
  readonly maxPaymentUsd: number;
  /** CAIP-2 network to pay on. Defaults to Base mainnet. */
  readonly network?: string;
}

/** The zero-friction default rail: x402 v2 with a local signing key. */
export function localKeyAuthority(options: LocalKeyAuthorityOptions): PaymentAuthority {
  if ((options.privateKey === undefined) === (options.account === undefined)) {
    throw new Error("provide exactly one of privateKey or account");
  }
  const account = options.account ?? privateKeyToAccount(options.privateKey as `0x${string}`);
  return {
    rails: ["x402-v2"],
    wrapFetch: (base) =>
      createPayableFetch({
        account,
        network: options.network,
        maxPaymentUsd: options.maxPaymentUsd,
        fetch: base,
      }),
    receipt: paymentReceipt,
  };
}

/** An authority that pays nothing: reads, price discovery, tests. */
export function inertAuthority(): PaymentAuthority {
  return {
    rails: [],
    wrapFetch: (base) => base,
    receipt: () => null,
  };
}
