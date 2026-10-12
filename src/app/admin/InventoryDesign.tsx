"use client"

// In-house gacha — DESIGN PREVIEW
//
// Nothing here writes anything: it is the UI shape for running our own
// inventory and our own draws, put up for review BEFORE any schema exists.
// The one thing that is real is the economics readout, because that is the
// part that has to be right (lib/admin-core.ts packEv, unit-tested): a pack
// whose expected payout exceeds its price loses money on every single pull,
// and no amount of good UI elsewhere recovers that.
//
// The mock rows below are illustrative values, not data.

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { packEv, type OddsRow } from "@/lib/admin-core"
import { money, Panel } from "./ui"

const MOCK_INVENTORY = [
  { card: "Charizard Base Set", grade: "PSA 9", tier: "Chase", value: 240_000, onHand: 2, held: 1 },
  { card: "Blastoise Base Set", grade: "PSA 8", tier: "Rare", value: 42_000, onHand: 6, held: 0 },
  { card: "Pikachu Illustrator", grade: "PSA 7", tier: "Grail", value: 1_850_000, onHand: 1, held: 0 },
  { card: "Machamp 1st Ed.", grade: "PSA 9", tier: "Common", value: 3_500, onHand: 214, held: 12 },
  { card: "Eevee Jungle", grade: "PSA 8", tier: "Common", value: 1_200, onHand: 480, held: 31 },
]

const MOCK_DRAWS = [
  { at: "10:42", user: "ka•••@x.io", pack: "Vault 30", won: "Machamp 1st Ed.", value: 3_500, seed: "9f3c…a11" },
  { at: "10:39", user: "0x4bae…6cf3", pack: "Vault 30", won: "Eevee Jungle", value: 1_200, seed: "1b70…4de" },
  { at: "10:31", user: "lu•••@x.io", pack: "Vault 250", won: "Blastoise Base Set", value: 42_000, seed: "c8a2…f09" },
]

export function InventoryDesign() {
  // Defaults model the mock inventory above at the "Vault 250" price: each
  // tier's average value is the card of that tier in the table, so the readout
  // is internally consistent and opens on a HEALTHY pack. Drag any number and
  // it goes red — which is the point of showing this at all.
  const [price, setPrice] = useState(25_000)
  const [cardsPerPack, setCardsPerPack] = useState(1)
  const [odds, setOdds] = useState<OddsRow[]>([
    { tier: "Common", pct: 82, avgValueCents: 1_200 },
    { tier: "Rare", pct: 15, avgValueCents: 42_000 },
    { tier: "Chase", pct: 2.99, avgValueCents: 240_000 },
    { tier: "Grail", pct: 0.01, avgValueCents: 1_850_000 },
  ])
  const ev = packEv(odds, price, cardsPerPack)
  const setRow = (i: number, patch: Partial<OddsRow>) =>
    setOdds(odds.map((r, j) => (i === j ? { ...r, ...patch } : r)))

  // How many packs before we expect to owe a card we only hold one of. This
  // is the question inventory-backed odds actually turn on: the margin can be
  // healthy and the pack still unfulfillable.
  const scarcest = odds.reduce((a, b) => (a.pct < b.pct ? a : b))
  const packsPerScarce = scarcest.pct > 0 ? Math.round(100 / scarcest.pct / cardsPerPack) : 0

  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-dashed border-brand/50 bg-brand/5 px-4 py-3 text-sm">
        <strong>Design preview.</strong> Nothing on this tab is wired to anything — no schema, no
        writes, and the tables are illustrative rows. The odds editor is live so the economics
        readout can be judged for real. Review the shape here before we build it.
      </p>

      <Panel
        title="Inventory"
        hint="Graded cards we hold. 'Held' is reserved against an open pack or an unshipped win."
        right={
          <span className="text-xs text-muted-foreground tabular-nums">
            5 SKUs · 703 units ·{" "}
            {money(MOCK_INVENTORY.reduce((n, r) => n + r.value * r.onHand, 0))} at cost
          </span>
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Card</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Unit value</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Held</TableHead>
                <TableHead className="text-right">Free</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {MOCK_INVENTORY.map((r) => (
                <TableRow key={r.card}>
                  <TableCell className="font-medium">{r.card}</TableCell>
                  <TableCell className="text-muted-foreground">{r.grade}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.tier}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.value)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.onHand}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.held || "—"}
                  </TableCell>
                  <TableCell
                    className={`text-right tabular-nums ${
                      r.onHand - r.held <= 1 ? "text-no" : ""
                    }`}
                  >
                    {r.onHand - r.held}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          Intake would be a CSV import or a per-card form — cheapest is the CSV a grader already
          gives us, so that is what this should take.
        </p>
      </Panel>

      <Panel
        title="Pack builder"
        hint="Odds are per card drawn. The readout is what decides whether this pack ships."
      >
        <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3">
              <label className="text-xs text-muted-foreground">
                Price (cents)
                <Input
                  type="number"
                  value={price}
                  min={0}
                  onChange={(e) => setPrice(Number(e.target.value) || 0)}
                  className="mt-1 h-9 w-32 tabular-nums"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Cards per pack
                <Input
                  type="number"
                  min={1}
                  value={cardsPerPack}
                  onChange={(e) => setCardsPerPack(Number(e.target.value) || 1)}
                  className="mt-1 h-9 w-32 tabular-nums"
                />
              </label>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Chance %</TableHead>
                  <TableHead className="text-right">Avg value</TableHead>
                  <TableHead className="text-right">Contributes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {odds.map((r, i) => (
                  <TableRow key={r.tier}>
                    <TableCell className="font-medium">{r.tier}</TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        step="0.1"
                        value={r.pct}
                        onChange={(e) => setRow(i, { pct: Number(e.target.value) })}
                        className="ml-auto h-8 w-24 text-right tabular-nums"
                        aria-label={`${r.tier} chance`}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        step="100"
                        value={r.avgValueCents}
                        onChange={(e) => setRow(i, { avgValueCents: Number(e.target.value) })}
                        className="ml-auto h-8 w-32 text-right tabular-nums"
                        aria-label={`${r.tier} average value in cents`}
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {money((r.pct / 100) * r.avgValueCents * cardsPerPack)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <aside className="space-y-3 self-start rounded-xl border border-border bg-surface-2/50 p-4">
            <div className="text-xs text-muted-foreground">Expected payout / pack</div>
            <div className="font-heading text-2xl tabular-nums">{money(ev.evCents)}</div>
            <div className="text-xs text-muted-foreground">House margin</div>
            <div
              className={`font-heading text-2xl tabular-nums ${
                ev.marginCents < 0 ? "text-no" : "text-yes"
              }`}
            >
              {money(ev.marginCents)}{" "}
              <span className="text-sm">({ev.marginPct.toFixed(1)}%)</span>
            </div>
            {ev.marginCents < 0 && (
              <p className="rounded-lg border border-no/40 bg-no/10 px-3 py-2 text-xs text-no">
                This pack pays out more than it costs. Every pull loses{" "}
                {money(-ev.marginCents)}. Publishing should be blocked, not warned.
              </p>
            )}
            {!ev.oddsValid && (
              <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
                Chances total {ev.totalPct.toFixed(2)}%, not 100 — the remainder has no defined
                outcome.
              </p>
            )}
            <hr className="border-border" />
            <p className="text-xs text-muted-foreground">
              Rarest tier is <strong>{scarcest.tier}</strong> at {scarcest.pct}% — expect to owe one
              roughly every <strong>{packsPerScarce.toLocaleString()}</strong> packs. Inventory has{" "}
              <strong>1</strong> free. Selling more than that many packs is an IOU.
            </p>
          </aside>
        </div>
      </Panel>

      <Panel
        title="Draws"
        hint="Every pull, what it awarded, and the seed that proves it wasn't picked after the fact."
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Pack</TableHead>
                <TableHead>Awarded</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Seed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {MOCK_DRAWS.map((d) => (
                <TableRow key={d.seed}>
                  <TableCell className="text-muted-foreground">{d.at}</TableCell>
                  <TableCell>{d.user}</TableCell>
                  <TableCell>{d.pack}</TableCell>
                  <TableCell className="font-medium">{d.won}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(d.value)}</TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {d.seed}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <Panel title="Open questions" hint="Answer these and the build is mostly mechanical.">
        <ol className="list-decimal space-y-2 px-8 py-4 text-sm text-muted-foreground marker:text-foreground">
          <li>
            <strong className="text-foreground">Does a win mint an NFT, or stay a DB row?</strong>{" "}
            Slabz made every card an NFT the user custodies. Our own inventory doesn&apos;t have to —
            a DB row plus a redeem/ship flow is far less machinery, but it breaks the &ldquo;you own
            it&rdquo; story and there is no sell-back market without a token.
          </li>
          <li>
            <strong className="text-foreground">Is the sell-back offer ours to fund?</strong> Slabz
            bought cards back at their price. In-house, that offer is house money and its own budget
            cap — or we drop it and cards are ship-only.
          </li>
          <li>
            <strong className="text-foreground">Are odds fixed, or floating on stock?</strong> Fixed
            odds are honest and simple, and can oversell a one-of-one. Odds that thin as stock
            drains never owe what they can&apos;t deliver, and are much harder to publish credibly.
          </li>
          <li>
            <strong className="text-foreground">How is fairness proven?</strong> The Seed column
            above assumes commit-reveal: we publish a hash before the pull, the seed after. It is
            the cheapest credible answer, but it only means anything if the commitment is public.
          </li>
          <li>
            <strong className="text-foreground">Who reserves stock, and when?</strong> At purchase,
            or at open? Reserving late oversells under concurrency; reserving early strands
            inventory behind abandoned checkouts.
          </li>
        </ol>
      </Panel>
    </div>
  )
}
