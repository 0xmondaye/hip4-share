// ERC-721 metadata for a wine bottle: PrizeNFT.tokenURI(id) = `${BASE_URI}${id}` and
// BASE_URI is https://hip4.gambitapp.io/api/prize/. tokenId = skuId << 16 | serial, so the
// catalog is keyed by skuId (the ops sheet's Rank) and the serial is the bottle number.
//
//   curl -s https://hip4.gambitapp.io/api/prize/65537 | jq      # sku 1, bottle 1
//
// The catalog and the label scans under public/prize/ (WebP) are generated, not hand-edited:
// gacha-contract/script/catalog.py rebuilds both from the ops sheet. `code` in the catalog
// equals PrizeNFT.skuCode(skuId) on-chain, which is the cross-check if a sheet is re-ranked.

import { NextResponse } from "next/server"
import catalog from "@/lib/wine-catalog.json"

const HOST = "https://hip4.gambitapp.io"
const SIXTEEN = BigInt(16)
const SERIAL_MASK = BigInt(0xffff)

type Wine = (typeof catalog)[keyof typeof catalog]
const wines = catalog as Record<string, Wine>

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^\d{1,29}$/.test(id)) return NextResponse.json({ error: "bad token id" }, { status: 400 })
  const tokenId = BigInt(id)
  const sku = (tokenId >> SIXTEEN).toString()
  const serial = Number(tokenId & SERIAL_MASK)
  const w = wines[sku]
  if (!w) return NextResponse.json({ error: "unknown sku" }, { status: 404 })

  const attributes: { trait_type: string; value: string | number }[] = [
    { trait_type: "Tier", value: w.tier },
    { trait_type: "Vintage", value: w.vintage },
    { trait_type: "SKU", value: w.code },
    { trait_type: "Bottle", value: serial },
  ]
  if (w.grape) attributes.push({ trait_type: "Grape", value: w.grape })
  if (w.abv != null) attributes.push({ trait_type: "ABV", value: w.abv })

  return NextResponse.json(
    {
      name: `${w.name} #${serial}`,
      description: `One bottle of ${w.name}, won from The Cellar. Sell it back to the house or have it shipped.`,
      image: `${HOST}/prize/${w.image}`,
      external_url: `${HOST}/gacha/cellar`,
      attributes,
    },
    // Immutable per id: the catalog only changes with a redeploy, and a redeploy purges the CDN.
    { headers: { "Cache-Control": "public, max-age=86400, s-maxage=86400" } },
  )
}
