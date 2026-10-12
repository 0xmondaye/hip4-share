// Answers ONE question: will Relay mint a SOLANA-origin deposit address that
// pays out to a Hyperliquid account? Quotes only, no signing, no money moves.
//
// It matters because the normal payout step can't be automated. A live quote
// (2026-08-21) returns one instruction against Relay's depository program
// 99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2, and account 1 is the user's
// wallet with isSigner TRUE. An SPL token delegate gives authority over token
// transfers, not the power to satisfy a program's signer constraint, so no
// amount of delegation lets our executor submit that instruction alone.
//
// A deposit address removes the instruction entirely: Relay watches an
// address, and anything landing there bridges with no signing at all. The
// sweep then becomes a plain SPL TransferChecked into it, and TransferChecked
// DOES accept a delegate as authority. One user-signed Approve, capped, and
// the executor can sweep forever after. Same shape as the HL agent wallet.
//
// Deposit addresses need the API key (keyless 400s with UNAUTHORIZED), which
// is why this is a script and not a test.
//   RELAY_API_KEY=<key> node scripts/relay-depaddr-diag.mjs <solAddr> <hlAddr> [units6]

const [sol, hl, amt = "5000000"] = process.argv.slice(2)
if (!sol || !hl) {
  console.error("usage: RELAY_API_KEY=<key> node scripts/relay-depaddr-diag.mjs <solAddr> <hlAddr> [units6]")
  process.exit(1)
}
const key = process.env.RELAY_API_KEY
if (!key) console.warn("! no RELAY_API_KEY — expect 400 UNAUTHORIZED, which is itself the answer\n")

const body = {
  user: sol,
  recipient: hl,
  originChainId: 792703809, // Solana
  destinationChainId: 1337, // Hyperliquid
  originCurrency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC (SPL)
  destinationCurrency: "0x00000000000000000000000000000000",
  amount: amt,
  tradeType: "EXACT_INPUT",
  protocolVersion: "v2",
  refundTo: sol,
  useDepositAddress: true,
}

const res = await fetch("https://api.relay.link/quote/v2", {
  method: "POST",
  headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
  body: JSON.stringify(body),
})
const json = await res.json().catch(() => null)
console.log("HTTP", res.status)
if (!res.ok) {
  console.log("REFUSED:", JSON.stringify(json))
  console.log("\n⇒ if this says deposit addresses are unsupported for SVM origin, the")
  console.log("  delegate plan is dead and the tab-closed gap stays open.")
  process.exit(0)
}

// A deposit address shows up as a step with no transaction for us to sign.
let addr = null
for (const step of json.steps ?? []) {
  console.log(`step ${step.id} kind=${step.kind} depositAddress=${step.depositAddress ?? "-"}`)
  addr ??= step.depositAddress ?? null
  for (const item of step.items ?? []) {
    const d = item.data ?? {}
    console.log("  data keys:", Object.keys(d).join(", ") || "(none)")
    if (Array.isArray(d.instructions))
      console.log("  ! still returns", d.instructions.length, "instruction(s) — not a pure deposit address")
  }
}
console.log("\ndepositAddress:", addr ?? "(none returned)")
console.log("delivered:", json.details?.currencyOut?.amount ?? "?", "(requested", amt + ")")
console.log("\n⇒ an address here + no instruction to sign means the sweep can be a plain")
console.log("  SPL TransferChecked, which a delegate can authorise. That is the green light.")
