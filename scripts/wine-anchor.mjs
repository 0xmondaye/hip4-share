// Mint a house-chain secret and print everything the deploy needs.
//
//   node --experimental-strip-types scripts/wine-anchor.mjs
//
// WINE_HOUSE_SECRET is server-only and never leaves the environment — it
// regenerates every link of the chain, so a leak hands the grinding advantage
// to the player. INSTANT_ANCHOR is public: it is the deploy constructor arg,
// or the argument to setHouseAnchor on a contract that is already live.
//
// Nothing is written anywhere. Losing the secret loses the chain, and the only
// recovery is a new secret plus a re-anchor (timelocked).

import { randomBytes } from "node:crypto"
import { anchorAction, houseChainFrom, WINE_CHAIN_LINKS } from "../src/lib/wine-core.ts"

const secret = randomBytes(32).toString("hex")
const anchor = houseChainFrom(secret)[0]

const action = anchorAction(anchor)

console.log(`WINE_HOUSE_SECRET=${secret}`)
console.log(`INSTANT_ANCHOR=${anchor}`)
console.log(`# ${WINE_CHAIN_LINKS} packs. Already-live contract: queue(${action}), then setHouseAnchor(${anchor}) after TIMELOCK.`)
