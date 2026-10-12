// Dry-run the gacha payout corridor (user Solana USDC → HL) through the SAME
// modules prod uses: quote body build → Relay quote → parseSolanaQuote →
// lookup-table fetch → unsigned v0 tx assembly. Quotes only — no signing, no
// money moves. Run against mainnet:
//   RELAY_API_KEY=<key> node --experimental-strip-types scripts/relay-payout-diag.mjs <solAddr> <hlAddr> [units6]
// Keyless also works (shape check only — sponsorship numbers need the key).
process.env.NEXT_PUBLIC_SLABZ_CLUSTER ??= "mainnet" // RPC picked at module load

const [sol, hl, amt] = process.argv.slice(2)
if (!sol || !hl) {
  console.error(
    "usage: node --experimental-strip-types scripts/relay-payout-diag.mjs <solAddr> <hlAddr> [units6]",
  )
  process.exit(1)
}

const { buildPayoutQuoteBody, parseSolanaQuote, quoteCovers } = await import(
  "../src/lib/gacha-relay-core.ts"
)
const { assembleInstructionsTxB64 } = await import("../src/lib/gacha-server/svm-tx.ts")
const { walletUsdcUnits6 } = await import("../src/lib/gacha-server/gas-sponsor.ts")

const units = amt ?? (await walletUsdcUnits6(sol))
console.log("wallet USDC units6:", units)
if (BigInt(units) === BigInt(0)) {
  console.error("wallet holds no USDC — pass an explicit units6 amount to quote anyway")
  process.exit(1)
}

const key = process.env.RELAY_API_KEY
const res = await fetch("https://api.relay.link/quote/v2", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(key ? { "x-api-key": key } : {}) },
  body: JSON.stringify(
    buildPayoutQuoteBody({ userSolAddr: sol, userHlAddr: hl, amountUnits6: units, subsidyCapUsdc: 5 }),
  ),
})
const data = await res.json().catch(() => null)
if (!res.ok || !data) {
  console.error("quote failed:", res.status, data?.message)
  process.exit(1)
}

const quote = parseSolanaQuote(data)
console.log("step kind      :", quote.step.kind)
console.log("requestId      :", quote.requestId)
console.log("delivered raw8 :", quote.receiveRaw)
const required = BigInt(units) * BigInt(100) - BigInt(1_000_000)
console.log(
  "quoteCovers    :",
  quoteCovers(quote.receiveRaw, String(required > BigInt(0) ? required : BigInt(0))),
  key ? "(keyed — prod sponsorship)" : "(KEYLESS — expect short, fees unsponsored)",
)

if (quote.step.kind === "instructions") {
  // stand-in house fee payer — prod assembles with the executor address, so
  // the dry-run tx must show TWO signer slots (house + user) like prod does
  const HOUSE = process.env.PAYOUT_FEE_PAYER ?? "Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc"
  const b64 = await assembleInstructionsTxB64(HOUSE, quote.step)
  const wire = Buffer.from(b64, "base64")
  const sigBytes = 1 + wire[0] * 64
  const ok = wire[0] === 2 && wire.subarray(1, sigBytes).every((b) => b === 0) && wire[sigBytes] === 0x80
  console.log("assembled tx   :", wire.length, "bytes,", wire[0], "signer slots, wire shape", ok ? "OK" : "BAD")
  if (!ok) process.exit(1)
} else {
  console.log("serialized tx from Relay directly — nothing to assemble")
}
console.log("\npayout corridor dry-run PASSED (nothing signed, nothing moved)")
