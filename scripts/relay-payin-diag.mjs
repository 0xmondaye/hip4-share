// Diagnose appFees × sponsorship on the gacha pay-in corridor (HL → Solana).
// Quotes only — no signing, no money moves. Run:
//   RELAY_API_KEY=<key from Vercel env> node scripts/relay-payin-diag.mjs <userHlAddr> <userSolAddr>
const key = process.env.RELAY_API_KEY
if (!key) {
  console.error("RELAY_API_KEY required (quotes are free; sponsorship only shows keyed)")
  process.exit(1)
}
const [hl, sol] = process.argv.slice(2)
if (!hl || !sol) {
  console.error("usage: node scripts/relay-payin-diag.mjs <userHlAddr> <userSolAddr>")
  process.exit(1)
}

const base = {
  user: hl,
  recipient: sol,
  originChainId: 1337,
  destinationChainId: 792703809,
  originCurrency: "0x00000000000000000000000000000000",
  destinationCurrency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "3000000000", // $30 in HL 8dp
  tradeType: "EXACT_INPUT",
  protocolVersion: "v2",
  refundTo: hl,
}
const appFees = [{ recipient: "0x2222222222222222222222222222222222222222", fee: "1666" }]

const variants = {
  "prod body (components, no app)": {
    ...base, appFees, subsidizeFees: true, subsidizeRent: true,
    sponsoredFeeComponents: ["execution", "swap", "relay", "rent"],
    maxSubsidizationAmount: "5000000",
  },
  "components, no subsidizeRent alias": {
    ...base, appFees, subsidizeFees: true,
    sponsoredFeeComponents: ["execution", "swap", "relay", "rent"],
    maxSubsidizationAmount: "5000000",
  },
  "blanket subsidize (pre-fix body)": {
    ...base, appFees, subsidizeFees: true, subsidizeRent: true,
    maxSubsidizationAmount: "5000000",
  },
  "appFees only, no sponsorship": { ...base, appFees },
  "sponsorship only, no appFees (executor-era 1:1)": {
    ...base, subsidizeFees: true, subsidizeRent: true, maxSubsidizationAmount: "5000000",
  },
}

for (const [name, body] of Object.entries(variants)) {
  const res = await fetch("https://api.relay.link/quote/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  const f = j?.fees ?? {}
  console.log(`\n== ${name} (${res.status})`)
  if (!res.ok) { console.log("  error:", j?.message); continue }
  console.log("  delivered :", j?.details?.currencyOut?.amountFormatted)
  console.log("  app       :", f.app?.amountFormatted ?? "0")
  console.log("  relayer   :", f.relayer?.amountFormatted ?? "0")
  console.log("  subsidized:", f.subsidized?.amountFormatted ?? "0")
}
