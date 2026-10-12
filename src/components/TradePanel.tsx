"use client"

import { useLogin, usePrivy, useWallets } from "@privy-io/react-auth"
import { useEffect, useMemo, useState } from "react"
import {
  approveBuilderFee,
  placeOutcomeOrder,
  sweepPerpsToSpot,
} from "@/lib/hl-exchange"
import { getPerpWithdrawable, getSpotUsdc } from "@/lib/hyperliquid"
import { explainSignError, reportClientError } from "@/lib/sign-error"
import type { EnrichedOutcome, Question } from "@/lib/types"
import { catOfOutcome, catOfQuestion } from "@/lib/types"
import { ConvertPanel } from "./ConvertPanel"
import { clampOutcomePrice, roundToTick } from "@/lib/hl-asset"
import { FlagImg } from "./FlagImg"
import { SportsLogo } from "./SportsLogo"
import { PopDigits } from "./PopDigits"
import { AnimatedCounter } from "./ui/animated-counter"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { DepositDialog } from "./DepositDialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  MinusSignIcon,
  PlusSignIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons"

interface TradePanelProps {
  outcome: EnrichedOutcome
  initialSide?: 0 | 1
  /** Small context line above the title, e.g. the market name. */
  context?: string
  /** Overrides the big title (defaults to side name for team markets). */
  title?: string
  /** Parent question — enables Merge Question / Negate Question converts. */
  question?: Question | null
  /** Drop the card chrome — the mobile drawer is already the container. */
  bare?: boolean
}

const CHIPS = [10, 50, 100, 500]
const ONE_TAP_AMOUNTS = [15, 25, 100]

export function fmtCents(mid: number | null): string {
  if (mid === null || !Number.isFinite(mid) || mid <= 0) return "—"
  return `${Math.round(mid * 100)}¢`
}

// still used by MarketsBrowser side buttons
export function fmtMult(mid: number | null): string {
  if (mid === null || !Number.isFinite(mid) || mid <= 0) return "—"
  const m = 1 / mid
  if (m >= 100) return `${Math.round(m).toLocaleString("en-US")}x`
  return `${m >= 10 ? m.toFixed(1) : m.toFixed(2)}x`
}

const ORDER_TYPE_LABELS = {
  "1tap": "1-Tap",
  market: "Market",
  limit: "Limit",
  convert: "Convert",
} as const

function abbr(name: string): string {
  return name.length <= 4 ? name.toUpperCase() : name.slice(0, 3).toUpperCase()
}

export function TradePanel({
  outcome,
  initialSide = 0,
  context,
  title,
  question,
  bare = false,
}: TradePanelProps) {
  const { ready, authenticated } = usePrivy()
  const { login } = useLogin()
  const { wallets } = useWallets()

  const [sideIdx, setSideIdx] = useState<0 | 1>(initialSide)
  const [tab, setTab] = useState<"buy" | "sell">("buy")
  const [usdcAmount, setUsdcAmount] = useState<string>("")
  // limit price in whole cents (1–99), Polymarket-style
  const [limitCents, setLimitCents] = useState<number | null>(null)
  const [tif, setTif] = useState<"Gtc" | "Ioc" | "Alo">("Gtc")
  const [orderTypeSel, setOrderType] = useState<
    "market" | "limit" | "1tap" | "convert" | null
  >(null)
  const orderType = orderTypeSel ?? "1tap"
  // ponytail: localStorage in effect (not initializer) to avoid hydration mismatch
  useEffect(() => {
    const v = localStorage.getItem("orderType")
    if (v === "market" || v === "limit" || v === "1tap") setOrderType(v)
  }, [])
  const [slipPct, setSlipPct] = useState(8)
  // ponytail: 1-Tap size multiplier, native range input — no slider lib
  const [oneTapMult, setOneTapMult] = useState(1)
  const [slipOpen, setSlipOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<
    | { kind: "ok"; oid?: number; msg: string }
    | { kind: "err"; msg: string }
    | null
  >(null)
  const [depositOpen, setDepositOpen] = useState(false)

  // "Must deposit before performing actions" → deposit dialog, not a red box
  const fail = (msg: string) => {
    if (/must deposit/i.test(msg)) setDepositOpen(true)
    else setResult({ kind: "err", msg })
  }

  const side = outcome.sides[sideIdx]
  const sideName =
    outcome.sideSpecs[sideIdx]?.name ?? (sideIdx === 0 ? "Yes" : "No")
  const isYesNo =
    (outcome.sideSpecs[0]?.name ?? "Yes") === "Yes" &&
    (outcome.sideSpecs[1]?.name ?? "No") === "No"

  const mid = side?.mid ?? null

  const midCents = mid !== null ? Math.round(clampOutcomePrice(mid) * 100) : 50

  const effectivePrice = useMemo(() => {
    if (orderType === "limit" && limitCents !== null) return limitCents / 100
    if (mid !== null) return clampOutcomePrice(mid)
    return 0.5
  }, [orderType, limitCents, mid])

  const amount = Number(usdcAmount)
  // ponytail: HL wants integer shares AND ≥$10 notional. Flooring $10 at 65.5¢
  // gives 15 shares = $9.83 → reject; user shouldn't hunt for $10.48. Budget
  // ≥ $10 → round up to clear the min (cost may exceed typed amount by < 1
  // share; cost line + button show the real number before submit).
  const minNotionalShares = (amt: number, px: number) =>
    amt >= 10 && px > 0 ? Math.ceil(10 / px) : 0
  const shares =
    amount > 0 && effectivePrice > 0
      ? Math.max(
          Math.floor(amount / effectivePrice),
          minNotionalShares(amount, effectivePrice),
        )
      : 0
  const cost = (shares * effectivePrice).toFixed(2)
  const isBuy = tab === "buy"

  useEffect(() => {
    setResult(null)
  }, [sideIdx, usdcAmount, limitCents, orderType, tab])

  // ponytail: Max = spot withdrawable, fetched on click — no balance polling
  const setMax = async () => {
    if (!authenticated) {
      login()
      return
    }
    const wallet =
      wallets.find((w) => w.walletClientType === "privy") ?? wallets[0]
    if (!wallet) return
    try {
      // spendable = free spot USDC + perps withdrawable (orders auto-sweep
      // perp→spot on shortfall, so both pools are buyable)
      const [perp, spot] = await Promise.all([
        getPerpWithdrawable(wallet.address),
        getSpotUsdc(wallet.address),
      ])
      const w = Math.floor(perp + spot.free)
      if (w > 0) setUsdcAmount(String(w))
    } catch {
      /* leave amount as-is */
    }
  }

  // amountOverride: 1-Tap buttons place immediately without touching input state
  const submit = async (amountOverride?: number) => {
    if (!authenticated) {
      login()
      return
    }
    const wallet =
      wallets.find((w) => w.walletClientType === "privy") ?? wallets[0]
    if (!wallet) {
      setResult({ kind: "err", msg: "No wallet found" })
      return
    }
    const amt = amountOverride ?? amount
    const isMarket = orderType !== "limit"
    // market orders cross the book with the user's max-slippage allowance
    const slip = 1 + (isBuy ? slipPct : -slipPct) / 100
    // HL reserves size × the order's limit price. Market buys post at the
    // slipped price, so size at THAT price — otherwise a "$15" buy reserves
    // up to $15 × slippage and fails on a $15 balance.
    const sizePrice =
      isMarket && isBuy
        ? clampOutcomePrice(effectivePrice * slip)
        : effectivePrice
    const sz =
      amt > 0 && sizePrice > 0
        ? Math.max(
            Math.floor(amt / sizePrice),
            minNotionalShares(amt, effectivePrice),
          )
        : 0
    if (sz < 1 || sz * effectivePrice < 10) {
      setResult({ kind: "err", msg: "Min size: $10 notional, 1+ share" })
      return
    }
    setBusy(true)
    setResult(null)
    try {
      const price = isMarket
        ? roundToTick(clampOutcomePrice(effectivePrice * slip))
        : roundToTick(effectivePrice)
      const params = {
        outcome: outcome.outcome,
        sideIdx,
        isBuy,
        price,
        size: String(sz),
        tif: isMarket ? ("FrontendMarket" as const) : tif,
      }
      type OrderStatus =
        | { resting: { oid: number } }
        | { filled: { totalSz: string; avgPx: string; oid: number } }
        | { error: string }
        | string
        | undefined
      const statusOf = (resp: Awaited<ReturnType<typeof placeOutcomeOrder>>) =>
        resp.response?.data?.statuses?.[0] as OrderStatus
      // nktkas THROWS ApiRequestError for per-order rejections ("order 0:
      // Insufficient spot balance…") instead of returning them in statuses —
      // convert back to a status so the retry logic below can react to it.
      const tryOrder = async (): Promise<OrderStatus> => {
        try {
          return statusOf(await placeOutcomeOrder(wallet, params))
        } catch (e) {
          if (e instanceof Error && e.name === "ApiRequestError")
            return { error: e.message }
          throw e
        }
      }
      let status = await tryOrder()
      // first order per user: approve the builder fee once, then retry
      if (
        status &&
        typeof status === "object" &&
        "error" in status &&
        /builder/i.test(status.error)
      ) {
        await approveBuilderFee(wallet)
        status = await tryOrder()
      }
      // Deposits credit the perps account but HIP-4 orders settle in spot
      // USDC — on shortfall sweep everything perp→spot and retry once
      // (one-balance policy: CEX users don't know the perp/spot split).
      if (
        isBuy &&
        status &&
        typeof status === "object" &&
        "error" in status &&
        /insufficient spot balance/i.test(status.error)
      ) {
        await sweepPerpsToSpot(wallet)
        status = await tryOrder()
        // Still short after the sweep → the money genuinely isn't there.
        // Show real numbers instead of HL's raw asset-id error.
        if (
          status &&
          typeof status === "object" &&
          "error" in status &&
          /insufficient spot balance/i.test(status.error)
        ) {
          const [perp, spot] = await Promise.all([
            getPerpWithdrawable(wallet.address),
            getSpotUsdc(wallet.address),
          ])
          const avail = (perp + spot.free).toFixed(2)
          const need = (sz * Number(price)).toFixed(2)
          const held = spot.total - spot.free
          fail(
            `This order needs $${need} but only $${avail} is available` +
              (held > 0.01
                ? ` ($${held.toFixed(2)} is reserved by your open orders — cancel them in Portfolio to free it up).`
                : ". Deposit more USDC to continue."),
          )
          return
        }
      }
      if (status && typeof status === "object" && "resting" in status) {
        setResult({
          kind: "ok",
          oid: status.resting.oid,
          msg: `Resting order #${status.resting.oid}`,
        })
      } else if (status && typeof status === "object" && "filled" in status) {
        const f = status.filled
        setResult({
          kind: "ok",
          oid: f.oid,
          msg: `Filled ${f.totalSz} @ ${f.avgPx}`,
        })
      } else if (status && typeof status === "object" && "error" in status) {
        fail(status.error)
      } else if (typeof status === "string") {
        setResult({ kind: "ok", msg: status })
      } else {
        setResult({ kind: "ok", msg: "Submitted" })
      }
    } catch (e) {
      console.error("order failed", e)
      reportClientError("trade", e, wallet)
      fail(explainSignError(e, "Unknown error").message)
    } finally {
      setBusy(false)
    }
  }

  const bigTitle = title ?? (isYesNo ? outcome.name : sideName)
  const sports = (question ? catOfQuestion(question) : catOfOutcome(outcome)) === "sports"

  // Every funding path below (balance reads, sweeps, deposit prompts) is spot
  // USDC; a market quoting another token would mis-fund, so refuse to trade it.
  if (outcome.quoteToken !== "USDC") {
    return (
      <div className={bare ? "" : "space-y-2"}>
        <Card
          className={`bg-surface py-0 gap-0 overflow-hidden ${
            bare ? "rounded-none bg-transparent ring-0" : "rounded-2xl"
          }`}
        >
          <div className={bare ? "px-4 py-3" : "p-5"}>
            <h3 className="text-xl font-semibold tracking-tight truncate">
              {bigTitle}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This market settles in {outcome.quoteToken}, which isn&apos;t
              supported for trading here yet.
            </p>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className={bare ? "" : "space-y-2"}>
      <Card
        className={`bg-surface py-0 gap-0 overflow-hidden ${
          bare ? "rounded-none bg-transparent ring-0" : "rounded-2xl"
        }`}
      >
        <div className={bare ? "px-4 pt-3" : "p-5 pb-0"}>
          {context && (
            <div className="text-xs text-muted-foreground truncate">
              {context}
            </div>
          )}
          <h3 className="text-xl font-semibold tracking-tight mt-0.5 truncate flex items-center gap-2">
            {sports ? (
              <SportsLogo name={isYesNo ? outcome.name : (outcome.templateArgs?.[sideIdx === 0 ? "participantA" : "participantB"] ?? sideName)} />
            ) : (
              <FlagImg name={bigTitle} className="h-5 rounded-[3px]" />
            )}
            <span className="truncate">{bigTitle}</span>
          </h3>

          <div className="mt-4 flex items-center justify-between border-b border-border">
            <Tabs
              value={tab}
              onValueChange={(v) => setTab(v as "buy" | "sell")}
            >
              <TabsList variant="line" className="gap-3 p-0 h-auto">
                {(["buy", "sell"] as const).map((k) => (
                  <TabsTrigger
                    key={k}
                    value={k}
                    className="capitalize font-semibold pb-2.5 px-1"
                  >
                    {k}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Select
              value={orderType}
              onValueChange={(v) => {
                setOrderType(v as typeof orderType)
                if (v && v !== "convert") localStorage.setItem("orderType", v)
              }}
            >
              <SelectTrigger
                size="sm"
                className="border-transparent dark:bg-transparent dark:hover:bg-transparent mb-1.5"
              >
                <SelectValue>{ORDER_TYPE_LABELS[orderType]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {Object.entries(ORDER_TYPE_LABELS).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className={`space-y-2 ${bare ? "px-4 py-3" : "p-5"}`}>
          {orderType !== "convert" && (
          <div className="flex gap-2">
            {outcome.sides.map((s, idx) => {
              const name =
                outcome.parsedMeta?.class === "priceBinary"
                  ? idx === 0
                    ? "Up"
                    : "Down"
                  : (outcome.sideSpecs[idx]?.name ?? (idx === 0 ? "Yes" : "No"))
              const active = sideIdx === idx
              const activeCls =
                idx === 0
                  ? "bg-yes/15 border-yes/40 text-yes"
                  : "bg-no/15 border-no/40 text-no"
              return (
                <button
                  key={s.coin}
                  type="button"
                  onClick={() => setSideIdx(idx as 0 | 1)}
                  className={`flex-1 rounded-full px-4 py-2.5 text-sm font-semibold transition border flex items-center justify-center gap-2 focus-visible:outline-current ${
                    active
                      ? activeCls
                      : "bg-surface-2 border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {sports && !isYesNo ? <SportsLogo name={outcome.templateArgs?.[idx === 0 ? "participantA" : "participantB"] ?? name} className="size-4" /> : <FlagImg name={name} />}
                  <span>{isYesNo ? name : abbr(name)}</span>
                  <span className="font-heading tabular-nums font-normal">
                    {fmtCents(s.mid)}
                  </span>
                </button>
              )
            })}
          </div>
          )}

          {orderType === "limit" && (
            <div className="rounded-xl border border-border bg-surface-2 px-4 py-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Limit</span>
                <Select
                  value={tif}
                  onValueChange={(v) => setTif(v as typeof tif)}
                >
                  <SelectTrigger
                    size="sm"
                    className="border-transparent dark:bg-transparent dark:hover:bg-transparent text-muted-foreground"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="Gtc">GTC</SelectItem>
                      <SelectItem value="Ioc">IOC</SelectItem>
                      <SelectItem value="Alo">ALO</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Decrease limit price"
                  onClick={() =>
                    setLimitCents(
                      Math.max(1, (limitCents ?? midCents) - 1),
                    )
                  }
                  className="text-muted-foreground"
                >
                  <HugeiconsIcon icon={MinusSignIcon} />
                </Button>
                <span className="text-4xl font-bold font-heading tabular-nums">
                  <PopDigits value={limitCents ?? midCents} />
                  <span className="text-muted-foreground font-semibold">
                    ¢
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Increase limit price"
                  onClick={() =>
                    setLimitCents(
                      Math.min(99, (limitCents ?? midCents) + 1),
                    )
                  }
                  className="text-muted-foreground"
                >
                  <HugeiconsIcon icon={PlusSignIcon} />
                </Button>
              </div>
              <div className="flex justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  className="text-xs font-semibold"
                  onClick={() => setLimitCents(midCents)}
                >
                  Set Mid Price
                </Button>
              </div>
            </div>
          )}

          {orderType === "1tap" ? (
            <div>
              <div className="text-base font-medium mb-2">Amount</div>
              <div className="grid grid-cols-3 gap-2">
                {ONE_TAP_AMOUNTS.map((base) => {
                  const v = base * oneTapMult
                  const payout = Math.floor(v / effectivePrice)
                  return (
                    <button
                      key={base}
                      type="button"
                      disabled={busy || !ready}
                      onClick={() => submit(v)}
                      className="rounded-xl border border-border bg-surface-2 px-3 py-4 text-center hover:border-foreground/30 transition disabled:opacity-50"
                    >
                      <div className="text-xl font-bold font-heading">${v}</div>
                      <div className="text-xs text-muted-foreground">
                        Payout{" "}
                        <span className="text-yes font-heading">${payout}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
              <div className="mt-4 flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={oneTapMult}
                  onChange={(e) => setOneTapMult(Number(e.target.value))}
                  aria-label="Scale 1-Tap amounts"
                  className="tap-slider flex-1"
                  style={
                    {
                      "--pct": `${((oneTapMult - 1) / 9) * 100}%`,
                    } as React.CSSProperties
                  }
                />
                <AnimatedCounter
                  value={oneTapMult}
                  suffix="x"
                  duration={0.4}
                  className="text-sm font-semibold font-heading w-8 justify-end"
                />
              </div>
            </div>
          ) : orderType === "convert" ? (
            <ConvertPanel
              outcome={outcome}
              question={question}
              fromLabel={bigTitle}
            />
          ) : (
            <>
              <div className="rounded-xl border border-border bg-surface-2 px-4 py-4 flex items-center justify-between gap-3">
                <span className="text-base font-medium shrink-0">Amount</span>
                <div className="flex items-center min-w-0 text-3xl font-semibold font-heading tabular-nums">
                  <span className="text-muted-foreground">$</span>
                  <input
                    inputMode="decimal"
                    value={usdcAmount}
                    onChange={(e) =>
                      setUsdcAmount(e.target.value.replace(/[^0-9.]/g, ""))
                    }
                    className="bg-transparent w-full max-w-[7ch] text-right focus:outline-none placeholder:text-muted-foreground"
                    placeholder="0"
                  />
                </div>
              </div>
              <div className="flex gap-1.5">
                {CHIPS.map((v) => (
                  <Button
                    key={v}
                    variant="secondary"
                    size="sm"
                    className="flex-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setUsdcAmount(String((Number(usdcAmount) || 0) + v))
                    }
                  >
                    +{v}
                  </Button>
                ))}
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
                  onClick={setMax}
                >
                  Max
                </Button>
              </div>
            </>
          )}

          {shares > 0 && (
            <div className="rounded-lg bg-surface-2 p-3 space-y-1.5 text-xs">
              <Row label="Shares">
                <span className="font-mono">{shares}</span>
              </Row>
              <Row label="Avg price">
                <span className="font-mono">{effectivePrice.toFixed(4)}</span>
              </Row>
              <Row label={isBuy ? "Cost" : "Proceeds"}>
                <span className="font-heading">${cost}</span>
              </Row>
              {isBuy && (
                <>
                  <Separator className="my-1" />
                  <Row label={`Payout if ${sideName} wins`}>
                    <span
                      className={`font-heading ${sideIdx === 0 ? "text-yes" : "text-no"}`}
                    >
                      ${shares.toFixed(2)}
                    </span>
                  </Row>
                </>
              )}
            </div>
          )}

          {orderType !== "1tap" && orderType !== "convert" && (
          <Button
            onClick={() => submit()}
            disabled={busy || !ready}
            className={`w-full h-12 rounded-xl font-bold text-base ${
              authenticated
                ? sideIdx === 0
                  ? "bg-yes hover:bg-yes/90 text-background focus-visible:border-yes focus-visible:ring-yes/50"
                  : "bg-no hover:bg-no/90 text-background focus-visible:border-no focus-visible:ring-no/50"
                : "bg-foreground hover:bg-foreground/90 text-background"
            }`}
          >
            {!ready
              ? "Loading…"
              : !authenticated
                ? "Sign In"
                : busy
                  ? "Signing…"
                  : `${isBuy ? "Buy" : "Sell"} ${sideName}${shares > 0 ? ` · $${cost}` : ""}`}
          </Button>
          )}

          {result && (
            // key remounts the box per message so the shake / check replays
            <div
              key={result.msg}
              className={`rounded-lg px-3 py-2 text-xs flex items-center gap-2 ${
                result.kind === "ok"
                  ? "bg-yes/10 text-yes border border-yes/30"
                  : "t-input is-shaking bg-no/10 text-no border border-no/30"
              }`}
            >
              {result.kind === "ok" && (
                <span
                  className="t-success-check shrink-0"
                  data-state="in"
                  aria-hidden="true"
                  style={{ "--check-y-amount": "8px" } as React.CSSProperties}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    className="size-3.5"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 12.5l5.5 5.5L20 6.5" />
                  </svg>
                </span>
              )}
              {result.msg}
            </div>
          )}

          <p className="text-xs text-muted-foreground leading-relaxed">
            Orders sign via your Privy wallet and post to Hyperliquid. Requires
            USDC in your Hyperliquid spot account (
            <button
              type="button"
              onClick={() => (authenticated ? setDepositOpen(true) : login())}
              className="text-brand hover:underline cursor-pointer"
            >
              deposit
            </button>
            ). Min order $10 notional.
          </p>
        </div>
      </Card>

      <DepositDialog open={depositOpen} onOpenChange={setDepositOpen} />

      <div
        className={`t-acc text-sm ${
          bare
            ? "border-t border-border px-4 py-3"
            : "rounded-2xl border border-border bg-surface px-5 py-4"
        }`}
        data-open={infoOpen}
      >
        <button
          type="button"
          onClick={() => setInfoOpen((v) => !v)}
          aria-expanded={infoOpen}
          className="w-full cursor-pointer flex items-center justify-between font-semibold"
        >
          Order Information
          <span className="t-acc-chevron">
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              className="size-4 text-muted-foreground"
            />
          </span>
        </button>
        <div className="t-acc-panel">
          <div className="t-acc-panel-inner">
            <div className="mt-3 space-y-2.5 text-sm">
              <Row label="Market price">
                <span className="font-heading tabular-nums">
                  {mid !== null ? `${(mid * 100).toFixed(2)}¢` : "—"}
                </span>
              </Row>
              <Row label="Estimated Cost">
                <span className="font-heading tabular-nums">
                  {shares > 0 ? `$${cost}` : "N/A"}
                </span>
              </Row>
              <div className="t-acc" data-open={slipOpen}>
                <Row label="Slippage">
                  <button
                    type="button"
                    onClick={() => setSlipOpen((v) => !v)}
                    aria-expanded={slipOpen}
                    className="font-mono tabular-nums flex items-center gap-1.5 hover:text-foreground transition"
                  >
                    Max. {slipPct}%
                    <span className="t-acc-chevron">
                      <HugeiconsIcon
                        icon={ArrowDown01Icon}
                        className="size-3.5 text-muted-foreground"
                      />
                    </span>
                  </button>
                </Row>
                <div className="t-acc-panel">
                  <div className="t-acc-panel-inner">
                    <div className="rounded-xl border border-border bg-surface-2 p-4 mt-2.5">
                      <div className="flex items-center justify-between">
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label="Decrease max slippage"
                          onClick={() => setSlipPct((v) => Math.max(1, v - 1))}
                          className="text-muted-foreground"
                        >
                          <HugeiconsIcon icon={MinusSignIcon} />
                        </Button>
                        <span className="text-2xl font-bold font-mono tabular-nums">
                          <PopDigits value={slipPct} />%
                        </span>
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label="Increase max slippage"
                          onClick={() => setSlipPct((v) => Math.min(50, v + 1))}
                          className="text-muted-foreground"
                        >
                          <HugeiconsIcon icon={PlusSignIcon} />
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                        Max slippage only affects market orders placed from the
                        order form. Limit orders rest at your chosen price.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <Row label="Fees">
                <span className="font-mono tabular-nums text-yes inline-flex items-center gap-1">
                  <HugeiconsIcon icon={ZapIcon} className="size-3.5" />
                  0.0000% / 0.0000%
                </span>
              </Row>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}
