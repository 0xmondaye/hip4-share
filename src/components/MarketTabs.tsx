"use client"

import { useWallets } from "@privy-io/react-auth"
import Link from "next/link"
import { useEffect, useState } from "react"
import {
  getAllMids,
  getOutcomePositions,
  hlInfo,
  type OutcomePosition,
} from "@/lib/hyperliquid"
import { Card } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface Sibling {
  id: number
  name: string
  pct: string
  href: string
}

export interface CoinRef {
  coin: string
  label: string
}

interface OpenOrder {
  coin: string
  oid: number
  side: "B" | "A"
  limitPx: string
  sz: string
  timestamp: number
}

interface Fill {
  coin: string
  px: string
  sz: string
  side: "B" | "A"
  time: number
}

const TABS = ["Positions", "Open Orders", "Trade History", "Outcomes"] as const

const fmtCents = (px: number) => {
  const c = px * 100
  return `${c >= 1 ? c.toFixed(1).replace(/\.0$/, "") : c.toPrecision(2)}¢`
}

export function MarketTabs({
  siblings,
  coins,
}: {
  siblings: Sibling[]
  coins: CoinRef[]
}) {
  const { wallets } = useWallets()
  const addr =
    (wallets.find((w) => w.walletClientType === "privy") ?? wallets[0])
      ?.address ?? null
  const [positions, setPositions] = useState<OutcomePosition[]>([])
  const [orders, setOrders] = useState<OpenOrder[]>([])
  const [fills, setFills] = useState<Fill[]>([])
  const [mids, setMids] = useState<Record<string, string>>({})

  const coinKey = coins.map((c) => c.coin).join(",")

  useEffect(() => {
    if (!addr || !coinKey) return
    const inMarket = new Set(coinKey.split(","))
    let aborted = false
    const load = async () => {
      try {
        const [p, o, f, m] = await Promise.all([
          getOutcomePositions(addr, { cache: "no-store" }),
          hlInfo<OpenOrder[]>(
            { type: "frontendOpenOrders", user: addr },
            { cache: "no-store" },
          ),
          hlInfo<Fill[]>(
            { type: "userFills", user: addr, aggregateByTime: false },
            { cache: "no-store" },
          ),
          getAllMids({ cache: "no-store" }),
        ])
        if (aborted) return
        setPositions(p.filter((x) => inMarket.has(x.coin)))
        setOrders(o.filter((x) => inMarket.has(x.coin)))
        setFills(f.filter((x) => inMarket.has(x.coin)))
        setMids(m)
      } catch {
        // ponytail: swallow — tabs fall back to the empty state; portfolio page surfaces errors
      }
    }
    void load()
    const t = setInterval(() => void load(), 10_000)
    return () => {
      aborted = true
      clearInterval(t)
    }
  }, [addr, coinKey])

  const label = (coin: string) =>
    coins.find((c) => c.coin === coin)?.label ?? coin

  const tabs = siblings.length > 0 ? TABS : TABS.slice(0, 3)

  const content = (t: (typeof TABS)[number]): React.ReactNode => {
    if (t === "Positions" && positions.length > 0)
      return (
        <Table>
          <TableHeader>
            <TableRow className="bg-surface-2/40 hover:bg-surface-2/40">
              <TableHead>Side</TableHead>
              <TableHead className="text-right">Shares</TableHead>
              <TableHead className="text-right">Entry</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead className="text-right">PnL</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((p) => {
              const mid = mids[p.coin] ? Number(mids[p.coin]) : null
              const value = mid !== null ? p.total * mid : p.entryNtl
              const pnl = mid !== null ? value - p.entryNtl : null
              return (
                <TableRow key={p.coin}>
                  <TableCell>{label(p.coin)}</TableCell>
                  <TableCell className="text-right font-mono">
                    {p.total.toLocaleString("en-US")}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {fmtCents(p.entryNtl / p.total)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    ${value.toFixed(2)}
                  </TableCell>
                  <TableCell
                    className={`text-right font-heading ${
                      (pnl ?? 0) >= 0 ? "text-yes" : "text-no"
                    }`}
                  >
                    {pnl !== null
                      ? `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`
                      : "—"}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )
    if (t === "Open Orders" && orders.length > 0)
      return (
        <Table>
          <TableHeader>
            <TableRow className="bg-surface-2/40 hover:bg-surface-2/40">
              <TableHead>Side</TableHead>
              <TableHead>Action</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Limit</TableHead>
              <TableHead className="text-right">Placed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o) => (
              <TableRow key={o.oid}>
                <TableCell>{label(o.coin)}</TableCell>
                <TableCell
                  className={`text-xs ${o.side === "B" ? "text-yes" : "text-no"}`}
                >
                  {o.side === "B" ? "Buy" : "Sell"}
                </TableCell>
                <TableCell className="text-right font-mono">{o.sz}</TableCell>
                <TableCell className="text-right font-mono">
                  {o.limitPx}
                </TableCell>
                <TableCell className="text-right font-mono text-muted-foreground text-xs">
                  {new Date(o.timestamp).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )
    if (t === "Trade History" && fills.length > 0)
      return (
        <Table>
          <TableHeader>
            <TableRow className="bg-surface-2/40 hover:bg-surface-2/40">
              <TableHead>Side</TableHead>
              <TableHead>Action</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fills.slice(0, 20).map((f, i) => (
              <TableRow key={`${f.coin}-${f.time}-${i}`}>
                <TableCell>{label(f.coin)}</TableCell>
                <TableCell
                  className={`text-xs ${f.side === "B" ? "text-yes" : "text-no"}`}
                >
                  {f.side === "B" ? "Buy" : "Sell"}
                </TableCell>
                <TableCell className="text-right font-mono">{f.sz}</TableCell>
                <TableCell className="text-right font-mono">{f.px}</TableCell>
                <TableCell className="text-right font-mono text-muted-foreground text-xs">
                  {new Date(f.time).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )
    if (t === "Outcomes" && siblings.length > 0)
      return (
        <div className="p-3 grid gap-1 sm:grid-cols-2">
          {siblings.map((s) => (
            <Link
              key={s.id}
              href={s.href}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-surface-2/60 transition"
            >
              <span className="truncate">{s.name}</span>
              <span className="font-mono tabular-nums text-muted-foreground shrink-0">
                {s.pct}
              </span>
            </Link>
          ))}
        </div>
      )
    return null
  }

  return (
    <Card className="rounded-2xl bg-surface py-0 gap-0 overflow-hidden">
      <Tabs defaultValue={TABS[0]}>
        <TabsList
          variant="line"
          className="w-full justify-start gap-2 px-5 pt-3 border-b border-border h-auto"
        >
          {tabs.map((t) => (
            <TabsTrigger key={t} value={t} className="flex-none pb-2.5">
              {t}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((t) => (
          <TabsContent key={t} value={t}>
            {content(t) ?? (
              <Empty className="py-14">
                <EmptyHeader>
                  <EmptyMedia variant="default" className="bg-surface-2" />
                  <EmptyTitle className="text-sm font-normal">
                    There&apos;s nothing to display
                  </EmptyTitle>
                  <EmptyDescription className="text-xs">
                    Open a position to get started ·{" "}
                    <Link href="/portfolio">view portfolio</Link>
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </Card>
  )
}
