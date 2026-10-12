"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import type { ReactNode } from "react";
import {
  arbitrum,
  base,
  hyperEvm,
  hyperliquidEvmTestnet,
  mainnet,
  optimism,
  polygon,
} from "viem/chains";
import { RPC_URL } from "@/lib/solana-client";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

// Privy's standard-wallet hooks (useStandardSignAndSendTransaction — the
// sponsored gacha sends) resolve their RPC from config.solana.rpcs and throw
// "No RPC configuration found for chain solana:mainnet" without an entry.
// Same cluster clamp as gacha-bridge.SOLANA_CHAIN (not imported — that module
// drags the whole gacha stack into the app-wide bundle).
const RAW_CLUSTER = process.env.NEXT_PUBLIC_SLABZ_CLUSTER ?? "devnet";
const SOLANA_CHAIN =
  RAW_CLUSTER === "mainnet"
    ? ("solana:mainnet" as const)
    : RAW_CLUSTER === "testnet"
      ? ("solana:testnet" as const)
      : ("solana:devnet" as const);
const SOLANA_RPCS = {
  [SOLANA_CHAIN]: {
    rpc: createSolanaRpc(RPC_URL),
    rpcSubscriptions: createSolanaRpcSubscriptions(RPC_URL.replace(/^http/, "ws")),
  },
};

// `supportedChains` REPLACES Privy's default list, so every chain an embedded
// wallet ever switchChain()s to must be here: Relay's signing domain (1), the
// five stranded-USDC recovery chains (recover.ts), and both HyperEVMs for the
// wine gacha — Privy ships 999 by default but not testnet 998.
const SUPPORTED_CHAINS = [mainnet, arbitrum, base, optimism, polygon, hyperEvm, hyperliquidEvmTestnet];

export function Providers({ children }: { children: ReactNode }) {
  if (!APP_ID) {
    return (
      <div className="m-8 p-4 rounded-lg border border-no/40 bg-no/10 text-sm">
        Missing <code>NEXT_PUBLIC_PRIVY_APP_ID</code> in .env.local
      </div>
    );
  }
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        appearance: {
          theme: "dark",
          // matches --brand (lime-400). Finer control — surfaces, borders,
          // radii — comes from the --privy-* body block in globals.css.
          accentColor: "#a3e635",
          logo: undefined,
          showWalletLoginFirst: false,
        },
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: {
          // Headless signing. The dashboard default (enforce_wallet_uis) pops
          // a Privy confirmation modal on every master-wallet signature; the
          // modal WithdrawDialog/Drawer focus-traps that modal into a dead
          // overlay, so withdrawals died on the first signature. Privy's own
          // guidance: never overlay their modal on another modal — see
          // https://docs.privy.io/basics/troubleshooting/multiple-dialogs
          showWalletUIs: false,
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
          // Slabz pack purchases sign Solana transactions. Requires Solana
          // embedded wallets enabled in the Privy dashboard.
          solana: {
            createOnLogin: "users-without-wallets",
          },
        },
        solana: { rpcs: SOLANA_RPCS },
        supportedChains: SUPPORTED_CHAINS,
      }}
    >
      {children}
    </PrivyProvider>
  );
}
