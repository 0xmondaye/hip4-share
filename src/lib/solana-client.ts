// Browser-side Solana reads + broadcast for the direct gacha flow — raw
// JSON-RPC over fetch, no SDK for three calls. Set NEXT_PUBLIC_SOLANA_RPC_URL
// to a provider URL (Helius etc.) in prod: the public mainnet RPC
// rate-limits browser sendTransaction hard.

const CLUSTER = process.env.NEXT_PUBLIC_SLABZ_CLUSTER ?? "devnet"
export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
  (CLUSTER === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com")
const USDC_MINT =
  process.env.NEXT_PUBLIC_SOLANA_USDC_MINT ??
  (CLUSTER === "mainnet"
    ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const json = (await res.json().catch(() => null)) as {
    result?: T
    error?: { message?: string }
  } | null
  if (!json || json.error)
    throw new Error(json?.error?.message ?? `Solana RPC ${method} failed`)
  return json.result as T
}

/** Raw USDC units (6dp) held by `owner`. */
export async function usdcUnits6(owner: string): Promise<bigint> {
  // `confirmed`, not the RPC default `finalized`: finalized trails confirmation
  // by ~13s, which delayed the sweeper noticing sale proceeds and made a
  // just-funded pack wallet read as unfunded.
  const result = await rpc<{
    value: { account: { data: { parsed: { info: { tokenAmount?: { amount?: string } } } } } }[]
  }>("getTokenAccountsByOwner", [
    owner,
    { mint: USDC_MINT },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ])
  return result.value.reduce(
    (acc, v) => acc + BigInt(v.account.data.parsed.info.tokenAmount?.amount ?? "0"),
    BigInt(0),
  )
}

export const unitsToCents = (units: bigint): number => Number(units / BigInt(10_000))

// Slabz slabs are Metaplex Core assets, not SPL tokens — getTokenAccountsByOwner
// never sees them. Ownership lives in the asset account itself: key byte 1
// (AssetV1) then the owner pubkey at bytes 1..33 (verified against mainnet).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
/** base58 (Bitcoin alphabet) — pubkeys here, and redeem-auth signatures in
 *  gacha-bridge. ponytail: 20 lines beats pulling bs58 into the bundle. */
export function b58(bytes: Uint8Array): string {
  let n = bytes.reduce((acc, b) => (acc << BigInt(8)) + BigInt(b), BigInt(0))
  let s = ""
  while (n > BigInt(0)) {
    s = B58[Number(n % BigInt(58))] + s
    n /= BigInt(58)
  }
  for (const b of bytes) {
    if (b !== 0) break
    s = "1" + s
  }
  return s
}

/** Which of `mints` (Core asset addresses) are currently owned by `owner`. */
export async function coreAssetsOwned(
  owner: string,
  mints: string[],
): Promise<Set<string>> {
  const held = new Set<string>()
  // ponytail: getMultipleAccounts caps at 100 keys — matches the tx-history
  // limit; chunk if history ever grows past it
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100)
    const r = await rpc<{ value: ({ data: [string, string] } | null)[] }>(
      "getMultipleAccounts",
      [chunk, { encoding: "base64" }],
    )
    r.value.forEach((v, j) => {
      if (!v) return
      const data = Uint8Array.from(atob(v.data[0]), (c) => c.charCodeAt(0))
      if (data[0] === 1 && b58(data.subarray(1, 33)) === owner) held.add(chunk[j])
    })
  }
  return held
}

/**
 * Broadcast a signed wire tx.
 *
 * Idempotency is TWO different claims and only one of them is true. At the
 * LEDGER level a re-send can never double-execute: the message hash is checked
 * against the status cache and rejected as AlreadyProcessed, and once the
 * blockhash ages out it fails BlockhashNotFound instead. But at the RPC level a
 * re-send is NOT a no-op that hands back the signature — preflight simulates the
 * already-landed transaction, returns an error, and `rpc()` above THROWS. So a
 * naive retry of a transaction that actually succeeded surfaces as a failure on
 * real money.
 *
 * If a retry loop is ever added here, it must pass `skipPreflight: true` (the
 * pattern Solana's own retry guide uses) and treat "already been processed" as
 * success. Today the single caller (CardCheckout) sends once, so this is a trap
 * for the next person rather than a live bug.
 */
export async function sendSignedTx(wireB64: string): Promise<string> {
  return rpc<string>("sendTransaction", [
    wireB64,
    { encoding: "base64", preflightCommitment: "confirmed" },
  ])
}

// ---- signature confirmation -------------------------------------------------
// Ask the CHAIN whether a tx landed, instead of asking a partner API when its
// own bookkeeping caught up. Solana confirms in about a second, so anything
// waiting minutes on a Solana settlement is waiting on the wrong thing.

export type SigState = "confirmed" | "failed" | "pending"

/**
 * One signature-status row → a verdict. Pure, so the commitment rules are
 * testable: "processed" is deliberately PENDING, not confirmed — a processed
 * tx can still be dropped on a fork, and this gates money copy. A missing row
 * is pending too (the RPC just hasn't seen it yet), never failed.
 */
export const sigVerdict = (
  row: { confirmationStatus?: string | null; err?: unknown } | null | undefined,
): SigState => {
  if (!row) return "pending"
  if (row.err != null) return "failed"
  return row.confirmationStatus === "confirmed" || row.confirmationStatus === "finalized"
    ? "confirmed"
    : "pending"
}

/**
 * Wait for `signature` to confirm. Returns "pending" if it hasn't landed by the
 * deadline — the caller decides whether that's worth surfacing; it is NOT a
 * failure (the tx may still confirm after we stop looking).
 * `searchTransactionHistory` so a signature older than the RPC's status cache
 * still resolves instead of reading as pending forever.
 */
export async function confirmSignature(signature: string, timeoutMs = 30_000): Promise<SigState> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await rpc<{
      value: ({ confirmationStatus?: string | null; err?: unknown } | null)[]
    }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]).catch(() => null)
    const v = sigVerdict(res?.value?.[0])
    if (v !== "pending") return v
    if (Date.now() >= deadline) return "pending"
    await new Promise((r) => setTimeout(r, 500))
  }
}
