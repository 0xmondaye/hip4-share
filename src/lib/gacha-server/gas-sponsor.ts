// House fee payer + on-chain reads for the direct gacha flow. The executor
// key (GACHA_EXECUTOR_SOLANA_KEY, env name kept to avoid Vercel churn) holds
// ONLY SOL and never touches USDC or NFTs: it is the fee payer on payout-leg
// transactions (server-side gas sponsorship — Privy's recommended DIY
// pattern; the SOL-drip era is gone). It co-signs in svm-tx.ts AFTER content
// verification, so its only exposure is the network fee.

import { address, createKeyPairSignerFromBytes, createSolanaRpc, getBase58Codec } from "@solana/kit"
import type { KeyPairSigner } from "@solana/kit"

const CLUSTER = process.env.NEXT_PUBLIC_SLABZ_CLUSTER ?? "devnet"
const RPC_URL =
  process.env.SOLANA_RPC_URL ??
  (CLUSTER === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com")
export const USDC_MINT =
  process.env.SOLANA_USDC_MINT ??
  (CLUSTER === "mainnet"
    ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")

export const rpc = () => createSolanaRpc(RPC_URL)

/** Accepts both secret formats: solana-keygen's JSON byte array
 *  ("[12,34,…]", 64 numbers) and a base58-encoded 64-byte string. */
function keyBytes(envName: string): Uint8Array {
  const raw = process.env[envName]?.trim()
  if (!raw)
    throw Object.assign(new Error(`${envName} not set`), {
      code: "NOT_CONFIGURED",
    })
  const bytes = raw.startsWith("[")
    ? Uint8Array.from(JSON.parse(raw) as number[])
    : (getBase58Codec().encode(raw) as Uint8Array)
  if (bytes.length !== 64)
    throw new Error(`${envName} must be 64 bytes, got ${bytes.length}`)
  return bytes
}

/** A house signer from an env-held secret key. */
export const signerFromEnv = (envName: string): Promise<KeyPairSigner> =>
  createKeyPairSignerFromBytes(keyBytes(envName))

/** The house fee-payer signer (address + CryptoKeyPair). */
export const executorSigner = (): Promise<KeyPairSigner> =>
  signerFromEnv("GACHA_EXECUTOR_SOLANA_KEY")

/** Raw USDC units (6dp) held by `owner`, as an integer string. */
export async function walletUsdcUnits6(owner: string): Promise<string> {
  const res = await rpc()
    // Explicit `confirmed`. NOT a behaviour change: `createSolanaRpc` already
    // applies `defaultCommitment: "confirmed"` (@solana/rpc
    // dist/index.node.mjs:45), so this read was never at `finalized`. Stated
    // outright because the SERVER's own JSON-RPC default is `finalized` and the
    // raw-fetch client in solana-client.ts genuinely was hitting that — the two
    // paths read the same balance and must agree. Confirmed is the right
    // commitment for "can I spend this": Slabz's buyback "completed" is gated on
    // confirmation, so a finalized read would trail a real payout by ~13s.
    .getTokenAccountsByOwner(
      address(owner),
      { mint: address(USDC_MINT) },
      { encoding: "jsonParsed", commitment: "confirmed" },
    )
    .send()
  let units = BigInt(0)
  for (const acc of res.value) {
    const info = acc.account.data.parsed.info as { tokenAmount?: { amount?: string } }
    units += BigInt(info.tokenAmount?.amount ?? "0")
  }
  return String(units)
}
