// Is the Cellar actually able to open a pack right now? One curl, no sign-in:
//
//   curl -s https://hip4.gambitapp.io/api/wine/status | jq
//
// Every field is public — an address, an on-chain counter, or a boolean. The
// house secret never appears; `expectedAnchor` is derived from it but is
// destined for the chain anyway, and the settler line reports only whether the
// configured key's ADDRESS equals the contract's settler.
//
// `ready` is false whenever a pull would fail, and the field that is false says
// why. Bring-up is: set the env, redeploy, curl, fix what reads false.

import { NextResponse } from "next/server"
import { anchorAction, publishedRound } from "@/lib/wine-core"
import {
  fetchDrandSignature,
  GACHA_ABI,
  WINE_CHAIN,
  WINE_GACHA_ADDRESS,
  wineConfigured,
  winePublicClient,
} from "@/lib/wine"
import { chainCovers, expectedAnchor, settlerAddress } from "@/lib/gacha-server/wine"

/** null instead of a throw: a probe reports what is broken, it doesn't break. */
const ok = <T>(f: () => Promise<T> | T) => Promise.resolve().then(f).catch(() => null)

export async function GET() {
  const chain = { id: WINE_CHAIN.id, name: WINE_CHAIN.name }
  if (!wineConfigured())
    return NextResponse.json({
      ready: false,
      configured: false,
      chain,
      missing: "NEXT_PUBLIC_WINE_GACHA_ADDRESS",
    })

  const address = WINE_GACHA_ADDRESS as `0x${string}`
  const pub = winePublicClient()
  const read = <T>(functionName: "prizeCount" | "stockEpoch" | "tokenCount" | "houseAnchor" | "settler") =>
    ok(() => pub.readContract({ address, abi: GACHA_ABI, functionName }) as Promise<T>)

  const [prizes, epoch, tokens, anchor, settler, code, beacon, keyAddr] = await Promise.all([
    read<bigint>("prizeCount"),
    read<number>("stockEpoch"),
    read<bigint>("tokenCount"),
    read<`0x${string}`>("houseAnchor"),
    read<`0x${string}`>("settler"),
    ok(() => pub.getCode({ address })),
    ok(async () => Boolean(await fetchDrandSignature(publishedRound(Date.now())))),
    ok(settlerAddress),
  ])

  const [gas, covered, expected] = await Promise.all([
    keyAddr ? ok(() => pub.getBalance({ address: keyAddr })) : null,
    anchor ? ok(() => chainCovers(anchor)) : null,
    ok(expectedAnchor),
  ])

  const matches = !!keyAddr && !!settler && keyAddr.toLowerCase() === settler.toLowerCase()
  const ready = Boolean(
    (code ?? "0x").length > 2 &&
      Number(prizes ?? 0) > 0 &&
      Number(tokens ?? 0) > 0 &&
      matches &&
      Number(gas ?? 0) > 0 &&
      beacon &&
      covered,
  )

  return NextResponse.json(
    {
      ready,
      configured: true,
      chain,
      gacha: address,
      deployed: (code ?? "0x").length > 2,
      pool: { prizes: Number(prizes ?? 0), epoch: epoch ?? 0, payTokens: Number(tokens ?? 0) },
      settler: {
        onContract: settler,
        fromKey: keyAddr,
        matches,
        hype: gas === null ? null : (Number(gas) / 1e18).toFixed(6),
      },
      // covered = the settler holds the link that hashes to the live anchor.
      // false means the wrong secret or an anchor this chain never produced;
      // `fix` is then the exact timelocked re-anchor, in order.
      houseChain: {
        liveAnchor: anchor,
        covered,
        fix:
          covered === false && expected
            ? { queue: anchorAction(expected), thenAfterTimelock: `setHouseAnchor(${expected})` }
            : null,
      },
      drandPublished: beacon,
    },
    { headers: { "cache-control": "public, max-age=10" } },
  )
}
