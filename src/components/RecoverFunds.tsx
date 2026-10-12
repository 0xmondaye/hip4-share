"use client"

import { useWallets } from "@privy-io/react-auth"
import { useCallback, useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  executeRecovery,
  scanStranded,
  type RecoverPhase,
  type StrandedFunds,
} from "@/lib/recover"
import { isUserRejection, WithdrawTrackableError } from "@/lib/relay-withdraw"
import { GetHelp } from "./GetHelp"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon } from "@hugeicons/core-free-icons"

const PHASE_LABEL: Record<RecoverPhase, string> = {
  quoting: "Preparing recovery…",
  signing: "Waiting for signature…",
  filling: "Bridging to Hyperliquid…",
  done: "Recovered ✓",
}

type RowState =
  | { kind: "idle" }
  | { kind: "busy"; phase: RecoverPhase }
  | { kind: "done"; receiveUsd: string }
  | { kind: "error"; message: string; requestId?: string }

/** Detects USDC stuck at the user's own address on an origin chain (sent on
 * the wrong network, or refunded there by Relay) and offers one-tap recovery
 * into their Hyperliquid balance. Renders nothing when there's nothing to
 * recover — most users never see this. */
export function RecoverFunds() {
  const { wallets } = useWallets()
  // Embedded wallets ONLY: "stranded" semantics hold just for the
  // app-custodied address. An external wallet's on-chain USDC is simply the
  // user's money in their own wallet — flagging it as lost and nudging it
  // into HL would be wrong on both counts.
  const wallet = wallets.find((w) => w.walletClientType === "privy")
  const addr = wallet?.address

  const [stranded, setStranded] = useState<StrandedFunds[]>([])
  const [rows, setRows] = useState<Record<number, RowState>>({})

  const scan = useCallback(() => {
    if (!addr) return
    scanStranded(addr).then(setStranded).catch(() => {})
  }, [addr])
  useEffect(scan, [scan])

  const setRow = (chainId: number, s: RowState) =>
    setRows((r) => ({ ...r, [chainId]: s }))

  const recover = async (s: StrandedFunds) => {
    if (!wallet) return
    try {
      const { receiveUsd } = await executeRecovery(wallet, s, (phase) =>
        setRow(s.chain.chainId, { kind: "busy", phase }),
      )
      setRow(s.chain.chainId, { kind: "done", receiveUsd })
      setTimeout(scan, 5000)
    } catch (e) {
      if (isUserRejection(e)) {
        setRow(s.chain.chainId, { kind: "idle" })
        return
      }
      setRow(s.chain.chainId, {
        kind: "error",
        message: e instanceof Error ? e.message : "Recovery failed",
        requestId: e instanceof WithdrawTrackableError ? e.requestId : undefined,
      })
    }
  }

  if (stranded.length === 0) return null

  return (
    <Card className="rounded-2xl bg-surface p-4 sm:p-5 space-y-3">
      <div className="flex items-start gap-2">
        <HugeiconsIcon
          icon={Alert02Icon}
          className="size-4 shrink-0 mt-0.5 text-brand"
        />
        <div className="text-sm leading-relaxed">
          <span className="font-semibold">
            We found USDC that never reached your balance.
          </span>{" "}
          <span className="text-muted-foreground">
            It was sent to your address on another network (or refunded
            there). Recover it into your Hyperliquid balance below — no gas
            needed.
          </span>
        </div>
      </div>
      <div className="space-y-2">
        {stranded.map((s) => {
          const row = rows[s.chain.chainId] ?? { kind: "idle" }
          return (
            <div
              key={s.chain.chainId}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm"
            >
              <span className="font-heading tabular-nums font-semibold">
                ${Number(s.amountUsd).toFixed(2)}
              </span>
              <span className="text-muted-foreground">
                USDC on {s.chain.name}
              </span>
              <div className="ml-auto flex items-center gap-2">
                {row.kind === "busy" ? (
                  <span className="text-xs text-muted-foreground">
                    {PHASE_LABEL[row.phase]}
                  </span>
                ) : row.kind === "done" ? (
                  <span className="text-xs text-yes">
                    Recovered ✓ ${Number(row.receiveUsd).toFixed(2)} lands in
                    your balance shortly
                  </span>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => void recover(s)}
                    className="text-xs font-semibold"
                  >
                    Recover
                  </Button>
                )}
              </div>
              {row.kind === "error" && (
                <div className="w-full text-xs text-no">
                  {row.message}{" "}
                  {row.requestId && (
                    <a
                      href={`https://relay.link/transaction/${row.requestId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      Track on Relay
                    </a>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <GetHelp />
    </Card>
  )
}
