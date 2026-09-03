import {
  AuscaClient,
  inertAuthority,
  localKeyAuthority,
  type PaymentAuthority,
} from "@ausca/sdk";

// Environment is the only configuration surface of the front door: a signing
// key and a mandatory per-call USD cap for paying. Artifact commits are
// keyless through the configured Ausca origin. Refusing to guess a spend
// limit is deliberate.

export type Environment = Readonly<Record<string, string | undefined>>;

export function paymentFromEnvironment(env: Environment): PaymentAuthority | null {
  const privateKey = env.AUSCA_PRIVATE_KEY;
  if (!privateKey) {
    return null;
  }
  const cap = Number(env.AUSCA_MAX_PAYMENT_USD);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error(
      "AUSCA_MAX_PAYMENT_USD must be a positive USD amount when AUSCA_PRIVATE_KEY is set; refusing to guess a spend limit",
    );
  }
  return localKeyAuthority({
    privateKey: privateKey as `0x${string}`,
    maxPaymentUsd: cap,
    network: env.AUSCA_NETWORK,
  });
}

export function clientFromEnvironment(
  env: Environment,
  options?: { requirePayment?: boolean },
): AuscaClient {
  const payment = paymentFromEnvironment(env);
  if (!payment && options?.requirePayment) {
    throw new Error(
      "paid invocations need AUSCA_PRIVATE_KEY and AUSCA_MAX_PAYMENT_USD in the environment",
    );
  }
  return new AuscaClient({
    payment: payment ?? inertAuthority(),
    origin: env.AUSCA_ORIGIN,
  });
}
