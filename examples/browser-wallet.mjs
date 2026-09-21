import { AuscaClient, x402Authority } from "@ausca/sdk";
import { ExactEvmScheme } from "@x402/evm";
import { createWalletClient, custom } from "viem";
import { base } from "viem/chains";

// Bundle this module in your browser app. Call it from an explicit user action.
// provider is an EIP-1193 wallet (for example, an EIP-6963-discovered MetaMask).
// Wallet connection and typed-data approval stay in that wallet; no key export.
export async function browserWalletClient(provider, maxPaymentUsd) {
  if (!Number.isFinite(maxPaymentUsd) || maxPaymentUsd <= 0) throw new Error("Set an explicit positive per-purchase USD cap.");
  const wallet = createWalletClient({ chain: base, transport: custom(provider) });
  const [address] = await wallet.requestAddresses();
  if (!address) throw new Error("The wallet did not authorize an account.");
  await wallet.switchChain({ id: base.id });
  return new AuscaClient({
    payment: x402Authority({
      schemes: [{
        network: "eip155:8453",
        client: new ExactEvmScheme({
          address,
          signTypedData: (message) => wallet.signTypedData({ ...message, account: address }),
        }),
      }],
      spendControls: { maxAmountPerPayment: `$${maxPaymentUsd}` },
    }),
  });
}

// Save a unique purchase key BEFORE invoke, and retain it if the wallet or
// HTTP connection closes. Reuse the same wallet/account, input and key on
// recovery. Never persist resource capabilities in browser analytics/logs.
// const client = await browserWalletClient(selectedProvider, 0.05);
// const outcome = await client.invoke("inbox.receive", { duration_seconds: 3600 }, {
//   idempotencyKey: savedPurchaseKey,
// });
