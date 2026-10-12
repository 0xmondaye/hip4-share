import assert from "node:assert/strict"
import { keccak256 } from "viem"
import {
  anchorAction,
  ceilUsd,
  decodePrize,
  drawIndex,
  drawSeed,
  encodeBottle,
  encodePrize,
  groupBySku,
  chainSeedFor,
  houseChain,
  houseChainFrom,
  pickPayToken,
  publishedRound,
  randomSeed,
  receiveAuthTypedData,
  replayDraws,
  requestId,
  serialOf,
  skuIdOf,
} from "./wine-core.ts"

const USER = "0x00000000000000000000000000000000000000a1"
const SEED = `0x${"11".repeat(32)}`
const BEACON = `0x${"22".repeat(32)}`
const HOUSE = `0x${"33".repeat(32)}`

// requestId vs an independently hand-packed abi.encode (7 static words) —
// two constructions, one keccak. This is the ERC-3009 nonce the contract
// recomputes; a mismatch means the signature authorises nothing.
{
  const w = (n) => n.toString(16).padStart(64, "0")
  const words =
    USER.slice(2).padStart(64, "0") +
    w(7) + // payToken
    w(10) + // count
    SEED.slice(2) +
    w(3) + // minAvailable
    w(42) + // epoch
    w(123456n) // round
  const req = { user: USER, payToken: 7, count: 10, userSeed: SEED, minAvailable: 3, epoch: 42, round: 123456n }
  assert.equal(requestId(req), keccak256(`0x${words}`))
  // the round is signature-bound: same request, other round, other nonce
  assert.notEqual(requestId({ ...req, round: 123457n }), requestId(req))
}

// prize word roundtrip + a hand-built word
{
  const col = "0x00000000000000000000000000000000000000ff"
  const w = encodePrize(col, 5n)
  assert.equal(w, (5n << 160n) | 0xffn)
  assert.deepEqual(decodePrize(w), { collection: col, tokenId: 5n })
}

// publishedRound: two rounds behind the newest, never below 1
{
  const GENESIS = 1727521075
  // exactly at the publish instant of round 11 (GENESIS + 10*3): newest = 11, pick 9
  assert.equal(publishedRound((GENESIS + 30) * 1000), 9n)
  assert.equal(publishedRound((GENESIS + 31) * 1000), 9n)
  assert.equal(publishedRound(GENESIS * 1000), 1n)
}

// drawSeed/drawIndex mirror the contract's packing: seed is
// keccak(userSeed ++ beacon ++ houseSeed ++ blockNumber ++ blockTimestamp),
// index is keccak(seed ++ (i<<160|user)) % poolSize
{
  const s = drawSeed(SEED, BEACON, HOUSE, 99n, 1700000000n)
  const w = (n) => n.toString(16).padStart(64, "0")
  assert.equal(
    s,
    keccak256(`0x${"11".repeat(32)}${"22".repeat(32)}${"33".repeat(32)}${w(99n)}${w(1700000000n)}`),
  )
  const expected = Number(BigInt(keccak256(`0x${s.slice(2)}${w((3n << 160n) | BigInt(USER))}`)) % 9n)
  assert.equal(drawIndex(s, USER, 3, 9), expected)
  assert.equal(drawIndex(s, USER, 0, 0), 0) // mirrors the contract's 0-pool edge
}

// replayDraws: swap-and-pop, no prize drawn twice, pool untouched
{
  const seed = drawSeed(SEED, BEACON, HOUSE, 1n, 2n)
  const pool = Array.from({ length: 8 }, (_, i) => encodePrize(USER, BigInt(i)))
  const before = [...pool]
  const won = replayDraws(seed, USER, pool, 8)
  assert.equal(won.length, 8)
  assert.equal(new Set(won.map(String)).size, 8) // each prize exactly once
  assert.deepEqual([...won].sort(), [...before].sort())
  assert.deepEqual(pool, before) // input not mutated
  assert.deepEqual(replayDraws(seed, USER, pool, 8), won) // deterministic
}

// houseChain: N+1 links, every link hashes to the one before it, tail last
{
  const s = houseChain(HOUSE, 5)
  assert.equal(s.length, 6)
  assert.equal(s[5], HOUSE)
  for (let i = 1; i <= 5; i++) assert.equal(keccak256(s[i]), s[i - 1])
}

// typed data shape: nonce and value land in the message, struct matches EIP-3009
{
  const td = receiveAuthTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 999, verifyingContract: USER },
    from: USER,
    to: USER,
    value: 100_000_000n,
    validAfter: 0n,
    validBefore: 123n,
    nonce: SEED,
  })
  assert.equal(td.primaryType, "ReceiveWithAuthorization")
  assert.equal(td.message.nonce, SEED)
  assert.equal(td.types.ReceiveWithAuthorization.length, 6)
}

// randomSeed: 32 bytes, nonzero, not repeating
assert.match(randomSeed(), /^0x[0-9a-f]{64}$/)
assert.notEqual(randomSeed(), randomSeed())

// pickPayToken: credit (highest id) before money, retired tokens skipped,
// shortfall reported against the cheapest real token when nothing affords
{
  const P = 100_000_000n
  const tokens = [
    { id: 0, priceUnits6: P }, // USDC
    { id: 1, priceUnits6: 0n }, // USDT retired
    { id: 2, priceUnits6: P }, // POINTS
  ]
  assert.equal(pickPayToken(tokens, { 0: 3n * P, 2: P }, 1).token.id, 2)
  assert.deepEqual(pickPayToken(tokens, { 0: 3n * P, 2: P }, 3), { token: tokens[0], shortfallUnits6: 0n })
  assert.equal(pickPayToken(tokens, { 1: 999n * P }, 1).token.id, 0)
  assert.deepEqual(pickPayToken(tokens, { 0: 40_000_000n }, 1), { token: tokens[0], shortfallUnits6: 60_000_000n })
  assert.deepEqual(pickPayToken(tokens, {}, 2), { token: tokens[0], shortfallUnits6: 2n * P })
  assert.equal(pickPayToken([{ id: 0, priceUnits6: 0n }], { 0: P }, 1), null)
}

// ceilUsd: never rounds down — $0.0001 short becomes a whole cent
assert.equal(ceilUsd(60_000_000n), 60)
assert.equal(ceilUsd(60_000_001n), 60.01)
assert.equal(ceilUsd(9_999n), 0.01)
assert.equal(ceilUsd(0n), 0)

console.log("wine-core tests passed")

// ── PrizeNFT bottle ids ──────────────────────────────────────────────────────
// The inventory page walks the collection by reconstructing ids from this
// scheme, so a wrong shift there is a bottle silently missing from the shelf —
// or, worse, a serial read as the wrong wine.
{
  assert.equal(encodeBottle(7, 1), (7n << 16n) | 1n)
  assert.equal(encodeBottle(0, 3), 3n) // what the plain stock() loop mints
  for (const [sku, serial] of [[0, 0], [0, 3], [7, 1], [9, 65535], [2 ** 40, 42]]) {
    const id = encodeBottle(sku, serial)
    assert.equal(skuIdOf(id), sku, `skuId lost for ${sku}/${serial}`)
    assert.equal(serialOf(id), serial, `serial lost for ${sku}/${serial}`)
  }
  // Every id these can build stays inside the uint96 the gacha accepts as a
  // prize — one bit more and onERC721Received reverts BadTokenId. The bound is
  // the number ceiling on skuId (2**53), well under the contract's uint80.
  assert.ok(encodeBottle(Number.MAX_SAFE_INTEGER, 65535) <= (1n << 96n) - 1n)
}

// Grouping is what the page renders: wines in id order, bottles in serial
// order, and an unregistered wine shown with an empty code rather than dropped.
{
  const b = (skuId, serial) => ({
    tokenId: encodeBottle(skuId, serial), skuId, serial,
    owner: "0x00000000000000000000000000000000000000a1", inPool: false,
  })
  const groups = groupBySku(
    [b(9, 2), b(7, 3), b(9, 1), b(7, 1)],
    new Map([[7, "IT1964R50499C016021"]]),
  )
  assert.deepEqual(groups.map((g) => g.skuId), [7, 9])
  assert.deepEqual(groups.map((g) => g.code), ["IT1964R50499C016021", ""])
  assert.deepEqual(groups[0].bottles.map((x) => x.serial), [1, 3])
  assert.deepEqual(groups[1].bottles.map((x) => x.serial), [1, 2])
  assert.deepEqual(groupBySku([], new Map()), [])
}

// A derived chain is reproducible from its secret and nothing else: same
// secret => same anchor, and the link for any anchor on it hashes back to that
// anchor. This is what replaced a database table, so a break here means the
// settler cannot reveal and every pull 503s CHAIN_EXHAUSTED.
{
  const a = houseChainFrom("correct horse battery staple", 50)
  const b = houseChainFrom("correct horse battery staple", 50)
  assert.deepEqual(a, b)
  assert.notEqual(houseChainFrom("another secret", 50)[0], a[0])
  assert.equal(a.length, 51)

  // walk the chain the way openPack does: reveal the link for the live anchor,
  // then the contract's anchor becomes that link
  let anchor = a[0]
  for (let i = 0; i < 5; i++) {
    const seed = chainSeedFor(a, anchor)
    assert.equal(keccak256(seed), anchor, `link ${i} must hash to the anchor`)
    anchor = seed
  }
  assert.equal(anchor, a[5])

  // case-insensitive on the anchor the RPC hands back, and null off-chain
  assert.equal(chainSeedFor(a, a[0].toUpperCase().replace("0X", "0x")), a[1])
  assert.equal(chainSeedFor(a, `0x${"de".repeat(32)}`), null)
  assert.equal(chainSeedFor(a, a[50]), null) // the tail reveals nothing further
}

// anchorAction must equal InstantGacha.anchorAction — a wrong key queues a
// timelock entry that setHouseAnchor will never consume. Verified against the
// live testnet contract at 0x78bD1334…F9Ce on 2026-09-04.
{
  assert.equal(
    anchorAction("0x9de74f3ce178daef3e85d4d6c0147a64206ed7dfee9cde0a3b44105784ad5e54"),
    "0x55a9bb47ea622663507513aabbc0d40d503bb204c930619dc05f2e7759a3ac3d",
  )
}
