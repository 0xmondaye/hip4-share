// Pure math for the on-chain wine gacha (InstantGacha.sol in the gacha-contract
// repo): drand round selection, prize-word packing, the ERC-3009 authorization
// nonce (= the contract's requestId), and an off-chain replay of the draw. No
// network, no env — everything here is exercised by wine-core.test.mjs.

import { encodeAbiParameters, keccak256, toFunctionSelector } from "viem"

// drand evmnet: round R is published at GENESIS + (R-1)*PERIOD (seconds).
// Same constants as the contract — a wrong round here is a signature the
// house can't submit, not a wrong draw.
const DRAND_GENESIS = 1727521075
const DRAND_PERIOD = 3

/**
 * A drand round that is already public at `nowMs`, two rounds (6s) behind the
 * newest so client clock skew can't pick one that isn't out yet. Freshness buys
 * nothing in InstantGacha — the house seed is what the player can't predict —
 * so older is strictly safer.
 */
export function publishedRound(nowMs: number): bigint {
  const r = Math.floor((nowMs / 1000 - DRAND_GENESIS) / DRAND_PERIOD) - 1
  return BigInt(Math.max(1, r))
}

// tsconfig targets ES2017, so no BigInt literals — constants instead
const B160 = BigInt(160)
const MASK160 = (BigInt(1) << B160) - BigInt(1)

/** Prize word: `uint96 tokenId << 160 | uint160 collection` (Prizes/prizeAt). */
export function decodePrize(word: bigint): { collection: `0x${string}`; tokenId: bigint } {
  const collection = `0x${(word & MASK160).toString(16).padStart(40, "0")}` as `0x${string}`
  return { collection, tokenId: word >> B160 }
}

export function encodePrize(collection: `0x${string}`, tokenId: bigint): bigint {
  return (tokenId << B160) | BigInt(collection)
}

/** Everything the player chooses — `InstantGacha.Request`, field order matters. */
export interface WineRequest {
  user: `0x${string}`
  payToken: number
  count: number
  userSeed: `0x${string}`
  minAvailable: number
  epoch: number
  round: bigint
}

/**
 * `InstantGacha.requestId(req)` = `keccak256(abi.encode(req))`. Also the
 * ERC-3009 nonce, so one signature authorises exactly one pack — change any
 * field, including the round, and the signature is dead.
 */
export function requestId(req: WineRequest): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint8" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "uint32" },
        { type: "uint32" },
        { type: "uint64" },
      ],
      [req.user, req.payToken, req.count, req.userSeed, req.minAvailable, req.epoch, req.round],
    ),
  )
}

/** EIP-3009 ReceiveWithAuthorization typed-data payload, ready for signTypedData. */
export function receiveAuthTypedData(args: {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` }
  from: `0x${string}`
  to: `0x${string}`
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: `0x${string}`
}) {
  return {
    domain: args.domain,
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization" as const,
    // Decimal STRINGS, not bigints, for the three uint256 fields. EIP-712 hashes them
    // identically — verified against hashTypedData, same digest either way — but the embedded
    // Privy wallet hands this object straight to `eth_signTypedData_v4`, and JSON.stringify
    // on a bigint throws "Do not know how to serialize a BigInt". With bigints the pull dies
    // at the signing step for every embedded wallet, which is most users. External wallets go
    // through viem, which normalises either form, so this is safe on both paths.
    message: {
      from: args.from,
      to: args.to,
      value: args.value.toString(),
      validAfter: args.validAfter.toString(),
      validBefore: args.validBefore.toString(),
      nonce: args.nonce,
    },
  }
}

const word = (n: bigint) => n.toString(16).padStart(64, "0")

/**
 * `keccak256(abi.encodePacked(userSeed, beacon, houseSeed, blockNumber, blockTimestamp))`
 * — mirrors InstantGacha.drawSeed. The block terms are the Opened log's own.
 */
export function drawSeed(
  userSeed: `0x${string}`,
  beacon: `0x${string}`,
  houseSeed: `0x${string}`,
  blockNumber: bigint,
  blockTimestamp: bigint,
): `0x${string}` {
  return keccak256(
    `0x${userSeed.slice(2)}${beacon.slice(2)}${houseSeed.slice(2)}${word(blockNumber)}${word(blockTimestamp)}` as `0x${string}`,
  )
}

/** `keccak256(seed, i << 160 | user) % poolSize` — mirrors InstantGacha.drawIndex. */
export function drawIndex(
  seed: `0x${string}`,
  user: `0x${string}`,
  i: number,
  poolSize: number,
): number {
  if (poolSize === 0) return 0
  const packed = (BigInt(i) << B160) | BigInt(user)
  const h = keccak256(`0x${seed.slice(2)}${word(packed)}` as `0x${string}`)
  return Number(BigInt(h) % BigInt(poolSize))
}

/**
 * Replay a pack off-chain: the contract's exact swap-and-pop draw over a
 * `prizeAt` snapshot. Returns the prize words in draw order — this is both the
 * "verify your pull" path and the mock-mode draw, so the UI's odds are the
 * contract's odds.
 */
export function replayDraws(
  seed: `0x${string}`,
  user: `0x${string}`,
  pool: bigint[],
  count: number,
): bigint[] {
  const p = [...pool]
  const out: bigint[] = []
  for (let i = 0; i < count; i++) {
    const idx = drawIndex(seed, user, i, p.length)
    out.push(p[idx])
    p[idx] = p[p.length - 1]
    p.pop()
  }
  return out
}

/** A fresh nonzero bytes32 (userSeed, or a mock beacon/houseSeed). */
export function randomSeed(): `0x${string}` {
  const b = new Uint8Array(32)
  globalThis.crypto.getRandomValues(b)
  b[31] |= 1 // BadSeed guard: the contract rejects a zero seed
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}` as `0x${string}`
}

/**
 * The house hash chain, built from a secret tail: `s[N] = tail`,
 * `s[i] = keccak256(s[i+1])`. Returns `[s[0], …, s[N]]`. `s[0]` is the anchor
 * the contract is deployed with (or `setHouseAnchor`ed to); `s[1], s[2], …`
 * are revealed one per pack, each hashing to the anchor before it.
 */
export function houseChain(tail: `0x${string}`, n: number): `0x${string}`[] {
  const s: `0x${string}`[] = new Array(n + 1)
  s[n] = tail
  for (let i = n - 1; i >= 0; i--) s[i] = keccak256(s[i + 1])
  return s
}

/**
 * How many packs one anchor is good for. A code constant, not an env var: the
 * anchor is a function of (secret, links), so a value that drifted between the
 * script and the server would silently produce an anchor nothing can serve.
 */
// ponytail: 20k packs per anchor, ~125ms to derive on a cold start. Raise it
// and re-anchor if a deployment ever gets close.
export const WINE_CHAIN_LINKS = 20_000

/**
 * The house chain derived from one secret. Deriving beats storing: the whole
 * chain is recomputable from `secret` alone, so there is no table to seed, no
 * database to keep in step with the deployment, and losing the chain can only
 * mean losing the secret. `secret` is server-only — every link is as sensitive
 * as the tail it came from.
 */
export function houseChainFrom(secret: string, n = WINE_CHAIN_LINKS): `0x${string}`[] {
  return houseChain(keccak256(new TextEncoder().encode(secret)), n)
}

/** `InstantGacha.anchorAction` — the timelock key for `setHouseAnchor(anchor)`. */
export function anchorAction(anchor: `0x${string}`): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes4" }, { type: "bytes32" }],
      [toFunctionSelector("setHouseAnchor(bytes32)"), anchor],
    ),
  )
}

/**
 * The link whose keccak256 is `anchor` — what `openPack` must reveal next.
 * Null when the live anchor is off this chain, which is the whole diagnosis:
 * wrong secret, or an anchor that was never derived from it.
 */
export function chainSeedFor(
  chain: `0x${string}`[],
  anchor: `0x${string}`,
): `0x${string}` | null {
  const a = anchor.toLowerCase()
  for (let i = 0; i < chain.length - 1; i++) if (chain[i].toLowerCase() === a) return chain[i + 1]
  return null
}

/** What the shelf knows about a payment token — the slice pickPayToken needs. */
export interface PayTokenLike {
  id: number
  priceUnits6: bigint
}

/**
 * Which token pays for `count` pulls. Retired tokens (price 0) never qualify.
 * Among the affordable ones the HIGHEST id wins: ids are assigned in deploy
 * order (USDC=0, USDT=1, POINTS=2), so gifted points are spent before real
 * money. Nothing affordable => the lowest-id priced token, with the shortfall
 * the UI should show. Null only when no token is priced at all.
 */
// ponytail: "highest id = credit" is a deploy-order convention, not a flag on
// the contract; read sellbackToken()/symbol if the order ever changes.
export function pickPayToken<T extends PayTokenLike>(
  tokens: T[],
  balances: Record<number, bigint>,
  count: number,
): { token: T; shortfallUnits6: bigint } | null {
  const priced = tokens.filter((t) => t.priceUnits6 > BigInt(0)).sort((a, b) => a.id - b.id)
  if (priced.length === 0) return null
  const cost = (t: T) => t.priceUnits6 * BigInt(count)
  const affordable = priced.filter((t) => (balances[t.id] ?? BigInt(0)) >= cost(t))
  if (affordable.length > 0) {
    const token = affordable[affordable.length - 1]
    return { token, shortfallUnits6: BigInt(0) }
  }
  const token = priced[0]
  return { token, shortfallUnits6: cost(token) - (balances[token.id] ?? BigInt(0)) }
}

/** 6dp units → whole cents as a USD number, rounded UP — a bridge that lands
 *  a cent short leaves the pull button exactly as disabled as before. */
export function ceilUsd(units6: bigint): number {
  return Number((units6 + BigInt(9_999)) / BigInt(10_000)) / 100
}

// ── PrizeNFT bottle ids ──────────────────────────────────────────────────────
// A bottle's id CARRIES its stock code: tokenId = uint80 skuId << 16 | uint16
// serial (PrizeNFT.encode). Many bottles of one wine share a skuId and differ
// only in serial, which is why a buyback quote covers a whole wine and why the
// inventory page can walk the collection without an index.

// ponytail: skuId as a number, exact only to 2**53 rather than the uint80 the
// contract allows. Ops assigns skuIds by hand and the SOP's are single digits,
// so the gap is unreachable in practice; a catalogue that ever numbers wines
// above 2**53 needs these four to take and return bigint.
export const encodeBottle = (skuId: number, serial: number): bigint =>
  (BigInt(skuId) << BigInt(16)) | BigInt(serial)
export const skuIdOf = (tokenId: bigint): number => Number(tokenId >> BigInt(16))
export const serialOf = (tokenId: bigint): number => Number(tokenId & BigInt(0xffff))

export interface Bottle {
  tokenId: bigint
  skuId: number
  serial: number
  owner: `0x${string}`
  /** Sitting in the gacha's prize pool, i.e. drawable right now. */
  inPool: boolean
}

export interface SkuGroup {
  skuId: number
  /** PrizeNFT.skuCode — "" when the wine was never registered (see setSku). */
  code: string
  bottles: Bottle[]
}

/** Bottles into one group per wine, wines by id, bottles by serial. */
export function groupBySku(bottles: Bottle[], codes: Map<number, string>): SkuGroup[] {
  const by = new Map<number, Bottle[]>()
  for (const b of bottles) {
    const list = by.get(b.skuId)
    if (list) list.push(b)
    else by.set(b.skuId, [b])
  }
  return [...by.entries()]
    .sort((a, z) => a[0] - z[0])
    .map(([skuId, list]) => ({
      skuId,
      code: codes.get(skuId) ?? "",
      bottles: [...list].sort((a, z) => a.serial - z.serial),
    }))
}
