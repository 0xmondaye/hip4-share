"use client";

import {
  getAccessToken,
  toViemAccount,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import { createWalletClient, custom } from "viem";
import { SessionExpiredError } from "./sign-error";

export type HlSigner = Awaited<ReturnType<typeof makeSigner>>;

export async function makeSigner(wallet: ConnectedWallet) {
  // Embedded wallets sign through Privy's iframe, which needs a live access
  // token; getAccessToken() refreshes an expired one, and null means truly
  // logged out — fail here with a clear error instead of letting the signer
  // surface an opaque "Failed to sign the typed data" wrapper.
  if (wallet.walletClientType === "privy") {
    const token = await getAccessToken().catch(() => null);
    if (!token) throw new SessionExpiredError();
    return await toViemAccount({ wallet });
  }
  // External wallets must NOT go through toViemAccount: it is built for the
  // embedded wallet and passes the typed data to eth_signTypedData_v4 as a
  // raw object, which strict external wallets (WalletConnect mobile, OKX,
  // older MetaMask) reject — the user just sees nktkas's "Failed to sign the
  // typed data using the wallet". A viem wallet client over the wallet's own
  // EIP-1193 provider serializes the payload to the JSON string the spec
  // requires, and nktkas adapts it via its viem-jsonrpc path.
  const provider = await wallet.getEthereumProvider();
  return createWalletClient({
    account: wallet.address as `0x${string}`,
    transport: custom(provider),
  });
}

/** Wallet's active chain as hex — user-signed actions must sign at this chain
 * or Privy rejects with "Provided chainId must match the active chainId". */
export function walletChainIdHex(wallet: ConnectedWallet): `0x${string}` {
  const id = Number(wallet.chainId.split(":").pop());
  return `0x${id.toString(16)}` as `0x${string}`;
}
