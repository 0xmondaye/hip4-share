"use client"

// Send HYPE out. The app is USDC-denominated and never asks for HYPE, but guests send it here
// anyway (an exchange withdrawal to "their Gambit wallet"), and until this existed it was
// invisible and stuck. One number: whatever sits in Core spot is moved to the HyperEVM side
// first (spotSend to the system address, gasless), then either a plain native transfer
// (HyperEVM · HYPE) or a Relay bridge to the picked chain/token, relayer fee sponsored.

import { useLogin, usePrivy, useWallets } from "@privy-io/react-auth"
import { useEffect, useRef, useState } from "react"
import { isAddress, parseEther } from "viem"
import { ACTIVATION_FEE_UNITS6, isActivationFeeError, moveHypeToHyperEvm } from "@/lib/hl-exchange"
import { getSpotState, getSpotUsdc } from "@/lib/hyperliquid"
import {
  HYPE_GAS_RESERVE_WEI,
  HYPEREVM_ENABLED,
  moveUsdcToHyperCore,
  readHyperEvmFunds,
  sendHypeOnHyperEvm,
} from "@/lib/hyperevm-funds"
import { executeHypeBridge, getHypeQuote, type HypePhase, type HypeQuote } from "@/lib/relay-hype"
import { isUserRejection, WithdrawTrackableError } from "@/lib/relay-withdraw"
import { HYPE_DESTINATIONS } from "@/lib/relay-withdraw-core"
import { explainSignError, reportClientError } from "@/lib/sign-error"
import { GetHelp } from "./GetHelp"
import { RelayLogo } from "./RelayLogo"
import { Button } from "@/components/ui/button"
import { Dialog } from "@base-ui/react/dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useMediaQuery } from "@/hooks/use-media-query"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, CheckmarkCircle02Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons"

const NATIVE_ID = "hyperevm-hype"
const DESTINATIONS = [{ id: NATIVE_ID, label: "HyperEVM · HYPE", symbol: "HYPE" }, ...HYPE_DESTINATIONS]

type Phase = "moving" | "activating" | HypePhase
const PHASE_LABEL: Record<Phase, string> = {
  moving: "Moving HYPE to HyperEVM…",
  activating: "Covering Hyperliquid's $1 account fee…",
  sending: "Sign transfer…",
  filling: "Bridging…",
}

/** wei → "1.2345" with at most 6 dp, floored so it never overstates. */
const fmtHype = (wei: bigint) => (Number(wei / BigInt(1e12)) / 1e6).toFixed(6).replace(/\.?0+$/, "")
const fmtOut = (s: string) => {
  const n = Number(s)
  return Number.isFinite(n) ? n.toFixed(n >= 1 ? 2 : 6).replace(/\.?0+$/, "") : s
}

type Result = { kind: "native"; hash: string; sent: string } | { kind: "relay"; requestId: string; sent: string }

export function SendHypeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { wallets } = useWallets()
  const { logout } = usePrivy()
  const { login } = useLogin()
  const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0]
  const user = wallet?.address ?? ""
  const isDesktop = useMediaQuery("(min-width: 1024px)")
  const quoteSeq = useRef(0)

  const [evmHype, setEvmHype] = useState<bigint | null>(null)
  const [coreHype, setCoreHype] = useState(0)
  const [amount, setAmount] = useState("")
  const [recipient, setRecipient] = useState("")
  const [destId, setDestId] = useState(NATIVE_ID)
  const [quote, setQuote] = useState<HypeQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<{ message: string; requestId?: string; sessionExpired?: boolean; reload?: boolean } | null>(null)

  const dest = DESTINATIONS.find((d) => d.id === destId) ?? DESTINATIONS[0]
  const viaRelay = destId !== NATIVE_ID

  useEffect(() => {
    if (!open || !user) return
    setAmount("")
    setRecipient("")
    setDestId(NATIVE_ID)
    setQuote(null)
    setQuoteError(null)
    setPhase(null)
    setResult(null)
    setError(null)
    setEvmHype(null)
    Promise.all([readHyperEvmFunds(user as `0x${string}`), getSpotState(user, { cache: "no-store" })])
      .then(([evm, spot]) => {
        setEvmHype(evm.hype)
        setCoreHype(spot.hype)
      })
      .catch(() => setEvmHype(null))
  }, [open, user])

  // Everything, minus gas for the send itself. Core HYPE has 8 dp; wei math keeps it exact.
  const totalWei = evmHype === null ? null : evmHype + parseEther(coreHype.toFixed(8))
  const maxWei = totalWei === null ? null : totalWei > HYPE_GAS_RESERVE_WEI ? totalWei - HYPE_GAS_RESERVE_WEI : BigInt(0)
  let amountWei: bigint | null = null
  try {
    amountWei = /^\d*\.?\d{0,18}$/.test(amount) && amount !== "" && amount !== "." ? parseEther(amount) : null
  } catch {
    amountWei = null
  }
  const amountOk = amountWei !== null && amountWei > BigInt(0) && maxWei !== null && amountWei <= maxWei
  const formOk = isAddress(recipient.trim()) && amountOk && !!user && HYPEREVM_ENABLED

  // Debounced Relay quote preview whenever the form is valid for a bridge destination.
  useEffect(() => {
    setQuote(null)
    setQuoteError(null)
    if (!viaRelay || !formOk || phase || amountWei === null) return
    const seq = ++quoteSeq.current
    const wei = amountWei.toString()
    const t = setTimeout(() => {
      getHypeQuote({ user, recipient: recipient.trim(), amountWei: wei, destinationId: destId })
        .then((q) => {
          if (quoteSeq.current === seq) setQuote(q)
        })
        .catch((e: Error) => {
          if (quoteSeq.current === seq) setQuoteError(e.message)
        })
    }, 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, recipient, destId, formOk, user, phase])

  const submit = async () => {
    if (!wallet || !formOk || phase || amountWei === null || evmHype === null) return
    if (viaRelay && !quote) return
    setError(null)
    const to = recipient.trim() as `0x${string}`
    const shown = quote
    try {
      // Not enough on the EVM side (amount + gas): bring the Core HYPE over. All of it -- HYPE
      // has no use on Core in this app, and one move is one signature.
      if (amountWei + HYPE_GAS_RESERVE_WEI > evmHype && coreHype > 0) {
        setPhase("moving")
        const coreAmount = (Math.floor(coreHype * 1e8) / 1e8).toFixed(8).replace(/\.?0+$/, "")
        try {
          await moveHypeToHyperEvm(wallet, coreAmount)
        } catch (e) {
          if (!isActivationFeeError(e)) throw e
          // Hyperliquid wants its one-time $1 in USDC and the account has none there — a guest
          // who only ever sent HYPE. Cover it from their HyperEVM USDC (gas sponsored), wait for
          // the credit, go again. No USDC anywhere: say exactly what to do.
          const evm = await readHyperEvmFunds(user as `0x${string}`).catch(() => null)
          if (!evm || evm.usdc < ACTIVATION_FEE_UNITS6)
            throw new Error(
              "Hyperliquid charges a one-time $1 fee on an account's first transfer out, taken in USDC. Deposit $1.01 USDC to your balance, then send your HYPE again.",
            )
          setPhase("activating")
          await moveUsdcToHyperCore(wallet, ACTIVATION_FEE_UNITS6)
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 2000))
            const spot = await getSpotUsdc(user).catch(() => null)
            if (spot && spot.free >= 1) break
          }
          setPhase("moving")
          await moveHypeToHyperEvm(wallet, coreAmount)
        }
        let now = evmHype
        for (let i = 0; i < 20 && now < amountWei + HYPE_GAS_RESERVE_WEI; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          now = await readHyperEvmFunds(user as `0x${string}`).then((f) => f.hype).catch(() => now)
        }
        setEvmHype(now)
        setCoreHype(0)
        if (now < amountWei + HYPE_GAS_RESERVE_WEI)
          throw new Error("HYPE is still on its way to HyperEVM — wait a moment and try again.")
      }
      if (!viaRelay) {
        setPhase("sending")
        const hash = await sendHypeOnHyperEvm(wallet, to, amountWei)
        setResult({ kind: "native", hash, sent: fmtHype(amountWei) })
        return
      }
      // Fresh quote at click time (the preview may have aged past its TTL during the move); if
      // it moved meaningfully against the user, ask for another click.
      setPhase("sending")
      const fresh = await getHypeQuote({ user, recipient: to, amountWei: amountWei.toString(), destinationId: destId })
      setQuote(fresh)
      if (shown && Number(fresh.receive) < Number(shown.receive) * 0.995) {
        setPhase(null)
        setError({ message: "The quote changed — review the updated amount and try again." })
        return
      }
      const r = await executeHypeBridge(wallet, fresh, setPhase)
      setResult({ kind: "relay", requestId: r.requestId, sent: fmtHype(amountWei) })
    } catch (e) {
      console.error("send hype failed", e)
      reportClientError("send-hype", e, wallet)
      if (e instanceof WithdrawTrackableError) setError({ message: e.message, requestId: e.requestId })
      else if (!isUserRejection(e)) setError(explainSignError(e, "Send failed"))
    } finally {
      setPhase(null)
    }
  }

  const busy = !!phase && !result
  const handleOpenChange = (o: boolean) => {
    if (!o && busy) return
    onOpenChange(o)
  }

  const description = "Send HYPE from your balance to your own wallet — as HYPE on HyperEVM, or as USDC or ETH on another chain."

  const body = result ? (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-10 text-yes" />
      <div className="text-sm">
        Sent <span className="font-heading tabular-nums">{result.sent} HYPE</span> to{" "}
        <span className="font-mono text-xs break-all">{recipient.trim()}</span>
        {result.kind === "native" ? " on HyperEVM." : ` as ${dest.label.replace(" · ", " ")}.`}
      </div>
      <a
        href={result.kind === "native" ? `https://hyperevmscan.io/tx/${result.hash}` : `https://relay.link/transaction/${result.requestId}`}
        target="_blank"
        rel="noreferrer noopener"
        className="flex items-center gap-1 text-xs text-brand hover:underline"
      >
        {result.kind === "native" ? "View transaction" : "View on Relay"}
        <HugeiconsIcon icon={LinkSquare02Icon} className="size-3.5" />
      </a>
    </div>
  ) : !user ? (
    <div className="rounded-xl border border-border bg-surface-2 px-3 py-6 text-center text-sm text-muted-foreground">
      Sign in to send.
    </div>
  ) : !HYPEREVM_ENABLED ? (
    <div className="rounded-xl border border-border bg-surface-2 px-3 py-6 text-center text-sm text-muted-foreground">
      Sending HYPE is available on mainnet only.
    </div>
  ) : (
    <>
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>Amount (HYPE)</span>
          <button
            type="button"
            className="text-brand hover:underline cursor-pointer disabled:opacity-50"
            disabled={maxWei === null || !!phase}
            onClick={() => maxWei !== null && setAmount(fmtHype(maxWei))}
          >
            Max <span className="font-heading tabular-nums">{maxWei !== null ? fmtHype(maxWei) : "…"}</span>
          </button>
        </div>
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          disabled={!!phase}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5 font-heading tabular-nums text-sm outline-none focus:border-brand"
        />
      </div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">Receive as</div>
        {/* ponytail: native <select> — one line, keyboard + mobile pickers for free */}
        <select
          value={destId}
          disabled={!!phase}
          onChange={(e) => setDestId(e.target.value)}
          className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm outline-none focus:border-brand"
        >
          {DESTINATIONS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted-foreground">Destination address</div>
        <input
          placeholder="0x…"
          value={recipient}
          disabled={!!phase}
          onChange={(e) => setRecipient(e.target.value)}
          spellCheck={false}
          className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5 font-mono text-xs outline-none focus:border-brand"
        />
        {recipient.trim() && !isAddress(recipient.trim()) && (
          <div className="mt-1 text-xs text-no">That is not a valid address.</div>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-no/30 bg-no/10 px-3 py-2 text-xs text-no">
        <HugeiconsIcon icon={Alert02Icon} className="mt-0.5 size-4 shrink-0" />
        <span>
          You&apos;ll receive <span className="font-semibold">{dest.label.replace(" · ", " ")}</span> — make sure the
          address can receive on that network. Transfers can&apos;t be reversed.
        </span>
      </div>

      {coreHype > 0 && (
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
          {coreHype.toFixed(4).replace(/\.?0+$/, "")} HYPE sits on Hyperliquid and moves over first (one extra
          signature).
        </div>
      )}

      {viaRelay && formOk && (
        <div className="space-y-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
          {quoteError ? (
            <div className="text-xs text-no">{quoteError}</div>
          ) : !quote ? (
            <div className="text-xs text-muted-foreground">Getting quote…</div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">You receive</span>
                <span className="font-heading tabular-nums">
                  {fmtOut(quote.receive)} {dest.symbol}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Fee</span>
                <span className="font-heading tabular-nums">${quote.totalFeeUsd}</span>
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="space-y-1 rounded-lg px-3 py-2 text-xs border bg-no/10 text-no border-no/30">
          <div>{error.message}</div>
          {error.requestId && (
            <a
              href={`https://relay.link/transaction/${error.requestId}`}
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              Track on Relay
            </a>
          )}
          {error.reload && (
            <button
              type="button"
              className="underline cursor-pointer"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          )}
          {error.sessionExpired && (
            <button
              type="button"
              className="underline cursor-pointer"
              onClick={async () => {
                await logout()
                login()
              }}
            >
              Log in again
            </button>
          )}
        </div>
      )}

      <Button
        onClick={submit}
        disabled={!formOk || !!phase || (viaRelay && !quote)}
        className="btn-brand w-full h-10 font-semibold"
      >
        {phase ? PHASE_LABEL[phase] : "Send"}
      </Button>
      <div className="flex flex-col items-center gap-2 pt-1">
        <p className="text-xs text-muted-foreground">Gas is taken from the HYPE you send.</p>
        <GetHelp />
        {viaRelay && (
          <a
            href="https://relay.link"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground shrink-0"
          >
            <span>Powered by</span>
            <RelayLogo className="h-3 w-auto" />
          </a>
        )}
      </div>
    </>
  )

  return isDesktop ? (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[min(90vw,26rem)] -translate-x-1/2 -translate-y-1/2 space-y-3 rounded-2xl bg-popover p-6 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <Dialog.Title className="text-lg font-semibold">Send HYPE</Dialog.Title>
          <Dialog.Description className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </Dialog.Description>
          {body}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  ) : (
    <Drawer open={open} onOpenChange={handleOpenChange} showSwipeHandle>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="text-lg font-semibold">Send HYPE</DrawerTitle>
          <DrawerDescription className="leading-relaxed">{description}</DrawerDescription>
        </DrawerHeader>
        <div className="space-y-3 overflow-y-auto p-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">{body}</div>
      </DrawerContent>
    </Drawer>
  )
}
