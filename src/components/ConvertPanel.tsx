"use client"

import { useLogin, usePrivy, useWallets } from "@privy-io/react-auth"
import { useEffect, useState } from "react"
import { convertOutcome, type ConvertParams } from "@/lib/hl-exchange"
import { getOutcomePositions, hlInfo } from "@/lib/hyperliquid"
import type { EnrichedOutcome, Question } from "@/lib/types"
import { coinFor } from "@/lib/types"
import { FlagImg } from "./FlagImg"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

type Mode = "split" | "merge" | "mergeQuestion" | "negate"

const MODES: { key: Mode; label: string; needsQuestion: boolean }[] = [
  { key: "split", label: "Split", needsQuestion: false },
  { key: "merge", label: "Merge", needsQuestion: false },
  { key: "mergeQuestion", label: "Merge Question", needsQuestion: true },
  { key: "negate", label: "Negate Question", needsQuestion: true },
]

const DESCRIPTIONS: Record<Mode, string> = {
  split: "Convert 1 USDC into 1 Yes share and 1 No share.",
  merge: "Convert 1 Yes share and 1 No share into 1 USDC.",
  mergeQuestion:
    "Merge Yes shares for each outcome of a question, including the Fallback outcome, into USDC. Combine with Negate Question to convert No shares to USDC.",
  negate:
    "Convert 1 No share for a specific outcome into 1 Yes share for all other outcomes, including 1 Fallback (FB) share.",
}

interface ConvertPanelProps {
  outcome: EnrichedOutcome
  /** Parent question; Merge Question / Negate Question hidden without one. */
  question?: Question | null
  /** Big title shown in the From row (market display name). */
  fromLabel: string
}

export function ConvertPanel({ outcome, question, fromLabel }: ConvertPanelProps) {
  const { ready, authenticated } = usePrivy()
  const { login } = useLogin()
  const { wallets } = useWallets()
  const wallet =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0]

  const [mode, setMode] = useState<Mode>("split")
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<
    { kind: "ok" | "err"; msg: string } | null
  >(null)
  // usdc withdrawable + share balances by coin ("#190" → szi)
  const [usdcAvl, setUsdcAvl] = useState<number | null>(null)
  const [shares, setShares] = useState<Record<string, number> | null>(null)

  const modes = MODES.filter((m) => !m.needsQuestion || question)

  useEffect(() => {
    setResult(null)
    setAmount("")
  }, [mode])

  useEffect(() => {
    if (!wallet?.address) return
    let aborted = false
    const load = async () => {
      try {
        const [s, positions] = await Promise.all([
          hlInfo<{ withdrawable?: string }>(
            { type: "clearinghouseState", user: wallet.address },
            { cache: "no-store" },
          ),
          getOutcomePositions(wallet.address, { cache: "no-store" }),
        ])
        if (aborted) return
        setUsdcAvl(Number(s.withdrawable ?? 0))
        setShares(
          // shares locked in resting orders can't be converted
          Object.fromEntries(
            positions.map((p) => [p.coin, p.total - p.hold]),
          ),
        )
      } catch {
        /* avl stays unknown */
      }
    }
    void load()
    return () => {
      aborted = true
    }
  }, [wallet?.address, busy]) // refetch after a convert completes

  const bal = (o: number, sideIdx: number) =>
    Math.max(0, shares?.[coinFor(o, sideIdx)] ?? 0)
  const yesAvl = bal(outcome.outcome, 0)
  const noAvl = bal(outcome.outcome, 1)
  // mergeQuestion burns X Yes of EVERY outcome incl. fallback → max is the min
  const questionOutcomes = question
    ? [
        ...question.namedOutcomes,
        ...(question.fallbackOutcome ? [question.fallbackOutcome] : []),
      ]
    : []
  const mergeQAvl = question
    ? Math.min(...questionOutcomes.map((id) => bal(id, 0)))
    : 0

  const avl: Record<Mode, { value: number | null; label: string }> = {
    split: { value: usdcAvl, label: "avl." },
    merge: { value: shares ? Math.min(yesAvl, noAvl) : null, label: "Yes / No avl." },
    mergeQuestion: { value: shares ? mergeQAvl : null, label: "Yes avl." },
    negate: { value: shares ? noAvl : null, label: "No avl." },
  }
  const curAvl = avl[mode]

  const amt = Number(amount)
  const valid = amt > 0 && Number.isFinite(amt)

  const fromInto: Record<Mode, [string, string]> = {
    split: [`$${valid ? amt : "—"} USDC`, `${valid ? amt : "—"} Yes + ${valid ? amt : "—"} No`],
    merge: [`${valid ? amt : "—"} Yes + ${valid ? amt : "—"} No`, `$${valid ? amt : "—"} USDC`],
    mergeQuestion: [`${valid ? amt : "—"} Yes of each outcome`, `$${valid ? amt : "—"} USDC`],
    negate: [`${valid ? amt : "—"} No`, `${valid ? amt : "—"} Yes of each other outcome`],
  }

  const submit = async () => {
    if (!authenticated) {
      login()
      return
    }
    if (!wallet || !valid) return
    const params: ConvertParams =
      mode === "split"
        ? { splitOutcome: { outcome: outcome.outcome, amount } }
        : mode === "merge"
          ? { mergeOutcome: { outcome: outcome.outcome, amount } }
          : mode === "mergeQuestion"
            ? { mergeQuestion: { question: question!.question, amount } }
            : {
                negateOutcome: {
                  question: question!.question,
                  outcome: outcome.outcome,
                  amount,
                },
              }
    setBusy(true)
    setResult(null)
    try {
      await convertOutcome(wallet, params)
      setResult({ kind: "ok", msg: "Converted" })
      setAmount("")
    } catch (e) {
      let msg = e instanceof Error ? e.message : "Convert failed"
      for (let c = (e as Error)?.cause; c instanceof Error; c = c.cause) {
        msg += ` — ${c.message}`
      }
      setResult({ kind: "err", msg })
    } finally {
      setBusy(false)
    }
  }

  const isUsd = mode === "split"

  return (
    <div className="space-y-2">
      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <TabsList variant="line" className="gap-3 p-0 h-auto w-full justify-start overflow-x-auto">
          {modes.map((m) => (
            <TabsTrigger
              key={m.key}
              value={m.key}
              className="text-xs font-semibold pb-2 px-0.5 whitespace-nowrap"
            >
              {m.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <p className="text-xs text-muted-foreground leading-relaxed">
        {DESCRIPTIONS[mode]}
      </p>

      <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 flex items-center gap-3">
        <FlagImg name={fromLabel} className="h-6 rounded-[3px]" />
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">From</div>
          <div className="text-sm font-semibold truncate">
            {mode === "mergeQuestion" || mode === "negate"
              ? (question?.name ?? fromLabel)
              : fromLabel}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 flex items-center justify-between gap-3">
        <div className="shrink-0">
          <div className="text-base font-medium">
            {isUsd ? "Amount" : "Shares"}
          </div>
          <div className="text-xs text-muted-foreground">
            {curAvl.value !== null
              ? `${isUsd ? "$" : ""}${Math.floor(curAvl.value)} ${curAvl.label}`
              : `${isUsd ? "$" : ""}— ${curAvl.label}`}
          </div>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center min-w-0 text-3xl font-semibold font-heading tabular-nums">
            {isUsd && <span className="text-muted-foreground">$</span>}
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) =>
                setAmount(e.target.value.replace(/[^0-9.]/g, ""))
              }
              className="bg-transparent w-full max-w-[6ch] text-right focus:outline-none placeholder:text-muted-foreground"
              placeholder="0"
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="text-xs font-semibold"
            onClick={() => {
              if (curAvl.value !== null && curAvl.value > 0)
                setAmount(String(Math.floor(curAvl.value)))
            }}
          >
            Max
          </Button>
        </div>
      </div>

      <div className="space-y-1.5 px-1 py-1 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Convert from</span>
          <span className="font-mono tabular-nums text-xs">
            {valid ? fromInto[mode][0] : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Convert into</span>
          <span className="font-mono tabular-nums text-xs">
            {valid ? fromInto[mode][1] : "—"}
          </span>
        </div>
      </div>

      <Button
        onClick={submit}
        disabled={busy || !ready || (authenticated && !valid)}
        className="w-full h-12 rounded-xl font-bold text-base"
      >
        {!ready
          ? "Loading…"
          : !authenticated
            ? "Sign In"
            : busy
              ? "Signing…"
              : "Confirm"}
      </Button>

      {result && (
        <div
          className={`rounded-lg px-3 py-2 text-xs border ${
            result.kind === "ok"
              ? "bg-yes/10 text-yes border-yes/30"
              : "bg-no/10 text-no border-no/30"
          }`}
        >
          {result.msg}
        </div>
      )}
    </div>
  )
}
