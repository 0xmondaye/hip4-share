"use client"

// Any USDC resting in the pack wallet (stalled bridge-back after a sellback,
// interrupted pull, short fill) sweeps itself to the HL balance. The Solana
// signature is headless (showWalletUIs:false), so there is nothing for the
// user to confirm — a manual "Move to balance" click was pure friction.
//
// Mounted from the gacha layout, so it survives navigation between gacha
// pages: a sellback whose bridge stalls on /gacha/collection is picked up
// here the moment the money lock frees, without the user going anywhere.

import { useCallback, useEffect, useRef, useState } from "react"
import { useWallets } from "@privy-io/react-auth"
import { useSignTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana"
import {
  bridgeBackToBalance,
  moneyLockHeld,
  pickPrivySolWallet,
  takeMoneyLock,
  SOLANA_CHAIN,
} from "@/lib/gacha-bridge"
import { SWEEP_DUST_CENTS } from "@/lib/gacha-core"
import { explainSignError } from "@/lib/sign-error"
import { unitsToCents, usdcUnits6 } from "@/lib/solana-client"
import { usd } from "@/lib/slabz"

// Enough to ride out a transient Relay/RPC failure, few enough that a
// genuinely broken sweep can't hammer Relay and the RPC in a loop. This is
// now the ONLY bound on repeated sweeps: the per-user daily send cap is gone
// (2026-08-25 — it defended ~$0.90/user/day and 429'd real users mid-sellback,
// see payout-send/route.ts), so don't raise this on the assumption that a
// server-side counter is still backstopping it.
const MAX_AUTO_TRIES = 3
const RETRY_DELAY_MS = 15_000

export function RecoverBalance({ className = "" }: { className?: string }) {
  const { wallets: evmWallets } = useWallets()
  const { wallets: solWallets } = useSolanaWallets()
  const { signTransaction } = useSignTransaction()
  const solWallet = pickPrivySolWallet(solWallets)
  const evmWallet = evmWallets.find((w) => w.walletClientType === "privy") ?? evmWallets[0]
  const solAddress = solWallet?.address

  const [cents, setCents] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // assume locked until the first check — never flash the banner on mount
  const [locked, setLocked] = useState(true)
  const inFlight = useRef(false)
  // Bounded auto-attempts per mount: a failing sweep must not loop against
  // Relay and the RPC, but ONE attempt was too few — a transient
  // Relay/RPC hiccup parked the money behind a manual click the user may never
  // look at again. Counted inside `recover`, so lock contention (which does no
  // work) never spends an attempt.
  const tries = useRef(0)

  const refresh = useCallback(() => {
    if (!solAddress) return
    usdcUnits6(solAddress)
      .then((u) => setCents(unitsToCents(u)))
      .catch(() => setCents(0))
  }, [solAddress])

  // an in-flight pull/sell legitimately parks money here — stay quiet while the
  // money lock is held, and keep re-reading the balance once it frees.
  //
  // Polling the balance at ALL is the fix for the stuck-funds report: the
  // balance used to be read only on mount and on the lock's held→free edge, and
  // a sellback that outruns its own Slabz poll releases the lock BEFORE the
  // payout lands. That one read saw $0, and nothing ever looked again — the
  // money sat in the pack wallet until the user happened to remount this.
  useEffect(() => {
    let n = 0
    let prevHeld = true
    const check = () => {
      const held = moneyLockHeld()
      if (prevHeld && !held) n = 0 // lock just freed — read now, not in 9s
      prevHeld = held
      setLocked(held)
      // the lock is a localStorage read (every tick); the balance is an RPC
      // round trip, so it rides every 3rd tick (~9s)
      if (!held && n++ % 3 === 0) refresh()
    }
    check()
    const id = setInterval(check, 3000)
    return () => clearInterval(id)
  }, [refresh])

  const recover = useCallback(async () => {
    if (inFlight.current || !solAddress) return
    const release = takeMoneyLock()
    if (!release) return // another op owns the wallet; the poll retries
    tries.current++ // only attempts that actually run count against the cap
    inFlight.current = true
    setBusy(true)
    setErr(null)
    try {
      // Wallets can still be hydrating on a cold load, so say something the
      // user can act on rather than no-opping silently.
      if (!evmWallet || !solWallet)
        throw new Error("Wallet is still connecting — retry in a moment.")
      await bridgeBackToBalance({
        solAddress,
        evmWallet,
        sign: async (tx) =>
          (await signTransaction({ transaction: tx, wallet: solWallet, chain: SOLANA_CHAIN }))
            .signedTransaction,
      })
    } catch (e) {
      // never render upstream copy raw on a money banner — Privy's rate-limit
      // string in particular reads like the sweep is dead when it isn't
      setErr(explainSignError(e).message)
    } finally {
      inFlight.current = false
      setBusy(false)
      release()
      refresh()
    }
  }, [evmWallet, solAddress, solWallet, signTransaction, refresh])

  // dust floor: the server refuses sweeps under it anyway (SWEEP_DUST_CENTS)
  const worthMoving = !locked && cents >= SWEEP_DUST_CENTS
  useEffect(() => {
    if (worthMoving && !busy && !err && tries.current < MAX_AUTO_TRIES) void recover()
  }, [worthMoving, busy, err, recover])

  // Re-arm the auto path after a failure instead of stranding the money behind
  // the Retry button. Clearing `err` re-runs the effect above; the attempt cap
  // is what stops this from becoming a loop.
  useEffect(() => {
    if (!err || tries.current >= MAX_AUTO_TRIES) return
    const id = setTimeout(() => setErr(null), RETRY_DELAY_MS)
    return () => clearTimeout(id)
  }, [err])

  // The pending state has no banner any more: money that moves itself doesn't
  // need a full-width green announcement, and the header balance spins while it
  // travels (AuthMenu reads the same money lock). This renders ONLY once the
  // auto path is spent and the sweep genuinely needs a human to press Retry.
  if (!err || busy || !worthMoving || tries.current < MAX_AUTO_TRIES) return null

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-xl border border-brand/40 bg-brand/10 px-4 py-3 ${className}`}
    >
      <div>
        <p className="text-sm font-medium">{usd(cents)} in your pack wallet</p>
        <p className="text-[11px] text-muted-foreground">
          That didn&apos;t go through — your money is safe in the pack wallet.
        </p>
        <p className="mt-1 text-[11px] text-no">{err}</p>
      </div>
      <button
        onClick={() => {
          tries.current = 0 // an explicit click always earns a fresh budget
          setErr(null)
          void recover()
        }}
        className="shrink-0 rounded-full border border-brand/40 bg-brand/15 px-4 py-1.5 text-xs font-medium text-brand transition hover:bg-brand/25"
      >
        Retry
      </button>
    </div>
  )
}
