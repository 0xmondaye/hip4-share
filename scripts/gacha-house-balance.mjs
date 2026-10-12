// House wallet balances — what the gift funder and the payout executor actually
// hold, on whichever cluster the env points at.
//
// Exists because an underfunded funder used to surface as an opaque SPL
// "custom program error: 0x1" out of a simulation. Run this before blaming code.
//
//   GACHA_GIFT_FUNDER_SOLANA_KEY=... node scripts/gacha-house-balance.mjs
//   # or, with the values already in .env.local:
//   node --env-file=.env.local scripts/gacha-house-balance.mjs
//
// Reads secret keys from env, derives the public addresses, and prints balances.
// It NEVER prints a key. Same key format as the server: a base58 string or a
// JSON byte array, 64 bytes either way.

import { createKeyPairSignerFromBytes, createSolanaRpc, address, getBase58Codec } from "@solana/kit"

const CLUSTER = process.env.NEXT_PUBLIC_SLABZ_CLUSTER ?? "devnet"
const RPC_URL =
  process.env.SOLANA_RPC_URL ??
  (CLUSTER === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com")
const USDC_MINT =
  process.env.SOLANA_USDC_MINT ??
  (CLUSTER === "mainnet"
    ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")

const rpc = createSolanaRpc(RPC_URL)
const usdc = (units) => (Number(units) / 1e6).toFixed(2)
const sol = (lamports) => (Number(lamports) / 1e9).toFixed(6)

async function addressFor(envName) {
  const raw = process.env[envName]?.trim()
  if (!raw) return null
  const bytes = raw.startsWith("[")
    ? Uint8Array.from(JSON.parse(raw))
    : getBase58Codec().encode(raw)
  if (bytes.length !== 64) throw new Error(`${envName} must be 64 bytes, got ${bytes.length}`)
  return (await createKeyPairSignerFromBytes(bytes)).address
}

async function report(label, envName, note) {
  const addr = await addressFor(envName).catch((e) => {
    console.log(`${label.padEnd(16)} ${envName}: ${e.message}`)
    return undefined
  })
  if (addr === null) {
    console.log(`${label.padEnd(16)} ${envName} not set`)
    return
  }
  if (addr === undefined) return

  const [lamports, tokens] = await Promise.all([
    rpc.getBalance(address(addr), { commitment: "confirmed" }).send(),
    rpc
      .getTokenAccountsByOwner(
        address(addr),
        { mint: address(USDC_MINT) },
        { encoding: "jsonParsed", commitment: "confirmed" },
      )
      .send(),
  ])
  let units = 0n
  for (const a of tokens.value) units += BigInt(a.account.data.parsed.info.tokenAmount?.amount ?? "0")

  console.log(`${label.padEnd(16)} ${addr}`)
  console.log(`${"".padEnd(16)}   SOL  ${sol(lamports.value)}`)
  console.log(
    `${"".padEnd(16)}   USDC ${usdc(units)} across ${tokens.value.length} account(s)`,
  )
  if (note) console.log(`${"".padEnd(16)}   ${note}`)
}

console.log(`cluster ${CLUSTER}`)
console.log(`rpc     ${RPC_URL}`)
console.log(`mint    ${USDC_MINT}\n`)

// The funder spends USDC (pack prices) and SOL (its own fees).
await report("gift funder", "GACHA_GIFT_FUNDER_SOLANA_KEY", "spends USDC per free pack + its own fees")
// The executor only ever pays fees — it should hold SOL and needs no USDC.
await report("payout executor", "GACHA_EXECUTOR_SOLANA_KEY", "fee payer only: needs SOL, not USDC")

console.log(
  "\nA gift grant needs the funder to hold at least the pack price in USDC on THIS cluster.\n" +
    "Holding devnet USDC while the env says mainnet (or vice versa) reads as a zero balance.",
)
