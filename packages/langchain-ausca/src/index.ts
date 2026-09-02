import { tool } from "@langchain/core/tools";
import type { LocalAccount } from "viem";
import type { z } from "zod";

import {
  payableCall,
  type PaymentReceipt,
} from "@ausca-internal/payable-core";

export type { PaymentReceipt } from "@ausca-internal/payable-core";

// A LangChain tool that consumes a paid HTTP API by answering its 402 with an
// x402 v2 payment instead of carrying an API key. It works against any x402
// resource; nothing here is specific to one vendor.

export interface PayableToolOptions<Schema extends z.ZodTypeAny> {
  /** Tool name shown to the model. */
  readonly name: string;
  /** What the tool does and what it costs, in the model's language. */
  readonly description: string;
  /** Zod schema of the tool input the model authors. */
  readonly schema: Schema;
  /** The payable resource URL. Any x402 v2 resource works. */
  readonly url: string;
  /** HTTP method of the payable resource. */
  readonly method?: "GET" | "POST";
  /** The signing account that pays. Never exposed to the model. */
  readonly account: LocalAccount;
  /** CAIP-2 network to pay on. Defaults to Base mainnet ("eip155:8453"). */
  readonly network?: string;
  /**
   * Hard per-call USD cap enforced before signing. The model can author the
   * request, never the spend authority.
   */
  readonly maxPaymentUsd: number;
  /** Extra request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Maps the model-authored input to the request body. Defaults to identity. */
  readonly buildBody?: (input: z.infer<Schema>) => unknown;
  /** Called with the settlement proof after each paid call. */
  readonly onPayment?: (payment: PaymentReceipt) => void;
}

/**
 * Builds a LangChain structured tool over one x402 payable resource. The tool
 * result is a JSON string carrying the resource result and, when the call was
 * paid, the decoded settlement proof.
 */
export function payableTool<Schema extends z.ZodTypeAny>(options: PayableToolOptions<Schema>) {
  return tool(
    async (input: z.infer<Schema>) => {
      const outcome = await payableCall(
        {
          url: options.url,
          method: options.method,
          account: options.account,
          network: options.network,
          maxPaymentUsd: options.maxPaymentUsd,
          headers: options.headers,
        },
        options.buildBody ? options.buildBody(input) : input,
      );
      if (outcome.payment && options.onPayment) {
        options.onPayment(outcome.payment);
      }
      return JSON.stringify({ result: outcome.result, payment: outcome.payment });
    },
    {
      name: options.name,
      description: options.description,
      schema: options.schema,
    },
  );
}
