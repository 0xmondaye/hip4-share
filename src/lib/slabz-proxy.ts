// Allowlist for the /api/gacha/* → Slabz partner API proxy. The API key is a
// secret (server-only, like HIP4_DASHBOARD_API_KEY) so the proxy must only
// forward the partner endpoints the UI actually needs — never arbitrary paths.

export const UUID = "[0-9a-fA-F-]{36}"
const MINT = "[1-9A-HJ-NP-Za-km-z]{32,44}" // base58 Solana address

const GET_PATHS = [
  /^packs$/,
  new RegExp(`^packs/${UUID}$`),
  new RegExp(`^packs/${UUID}/cards$`),
  /^transactions$/,
  new RegExp(`^transactions/${UUID}$`),
  new RegExp(`^transactions/${UUID}/buyback/quote$`),
  new RegExp(`^transactions/${UUID}/buyback/status$`),
  new RegExp(`^cards/${MINT}/buyback/quote$`),
  new RegExp(`^transactions/${UUID}/redeem/status$`),
  // gifting: list/read so the UI can show claimable free packs. Creation and
  // funding never go through the proxy — /api/gacha/gift-grant only.
  /^gifts$/,
  new RegExp(`^gifts/${UUID}$`),
]

const POST_PATHS = [
  new RegExp(`^packs/${UUID}/purchase$`),
  new RegExp(`^packs/${UUID}/bulk-purchase$`),
  new RegExp(`^transactions/${UUID}/submit$`),
  new RegExp(`^transactions/${UUID}/open$`),
  new RegExp(`^transactions/${UUID}/buyback$`),
  new RegExp(`^transactions/${UUID}/buyback/submit$`),
  // redeem (physical shipping). ponytail: no address list/PATCH/DELETE — each
  // redeem POSTs a fresh address, so the proxy stays GET+POST only. Add them
  // (and the methods) if users ever need a saved address book.
  new RegExp(`^transactions/${UUID}/redeem/auth$`),
  new RegExp(`^transactions/${UUID}/redeem/auth/verify$`),
  new RegExp(`^transactions/${UUID}/redeem/addresses$`),
  new RegExp(`^transactions/${UUID}/redeem/estimate$`),
  new RegExp(`^transactions/${UUID}/redeem/prepare$`),
  new RegExp(`^transactions/${UUID}/redeem/burn$`),
  // resume: rebuild an already-prepared shipment's burn txs with a fresh
  // blockhash. Spends nothing on its own and cannot create a second shipment.
  new RegExp(`^transactions/${UUID}/redeem/resume$`),
  // gift claim: Slabz verifies the receiver wallet's ed25519 signature, so
  // only the gifted wallet can spend a pack — the proxy just needs auth.
  new RegExp(`^gifts/${UUID}/claim/init$`),
  new RegExp(`^gifts/${UUID}/claim/complete$`),
]

export function isAllowed(method: string, path: string): boolean {
  const list =
    method === "GET" ? GET_PATHS : method === "POST" ? POST_PATHS : []
  return list.some((re) => re.test(path))
}
