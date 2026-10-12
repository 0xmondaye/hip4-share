"use client"

import { useLogin, usePrivy, useWallets } from "@privy-io/react-auth"
import { useEffect, useRef, useState } from "react"
import { isAddress } from "viem"
import {
  executeWithdraw,
  getWithdrawQuote,
  isUserRejection,
  MIN_WITHDRAW_USD,
  WITHDRAW_FEE_BPS,
  WithdrawTrackableError,
  type WithdrawPhase,
  type WithdrawQuote,
} from "@/lib/relay-withdraw"
import { coverPerpsFromSpot, isActivationFeeError } from "@/lib/hl-exchange"
import { explainSignError, reportClientError } from "@/lib/sign-error"
import { getPerpWithdrawable, getSpotUsdc, isHlActivated } from "@/lib/hyperliquid"
import { HYPEREVM_ENABLED, moveUsdcToHyperCore, readHyperEvmFunds } from "@/lib/hyperevm-funds"
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
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  LinkSquare02Icon,
} from "@hugeicons/core-free-icons"

interface WithdrawDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const PHASE_LABEL: Record<WithdrawPhase, string> = {
  authorizing: "Sign authorization (1/2)…",
  sending: "Sign transfer (2/2)…",
  filling: "Sending to Arbitrum…",
  done: "Done",
}

/** Withdraw perps USDC to any Arbitrum address via Relay. Two wallet
 * signatures (master wallet), no on-chain transaction, ~2 s fill. */
export function WithdrawDialog({ open, onOpenChange }: WithdrawDialogProps) {
  const { wallets } = useWallets()
  const { logout } = usePrivy()
  const { login } = useLogin()
  const wallet =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0]
  const user = wallet?.address ?? ""

  const [withdrawable, setWithdrawable] = useState<string | null>(null)
  // What sits on the trading side alone. The user sees one number; an amount above this is
  // topped up from the HyperEVM wallet before the Relay leg runs.
  const [coreAvail, setCoreAvail] = useState<number | null>(null)
  // Hyperliquid's one-time $1 activation fee is due on this account's first transfer out. Known
  // up front (isHlActivated), so Max already leaves room for it instead of the guest learning
  // from a refused transfer.
  const [activationFee, setActivationFee] = useState(false)
  const [amount, setAmount] = useState("")
  const [recipient, setRecipient] = useState("")
  const [quote, setQuote] = useState<WithdrawQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [phase, setPhase] = useState<WithdrawPhase | null>(null)
  const [result, setResult] = useState<{ requestId: string } | null>(null)
  const [error, setError] = useState<{
    message: string
    requestId?: string
    sessionExpired?: boolean
    reload?: boolean
  } | null>(null)
  const isDesktop = useMediaQuery("(min-width: 1024px)")
  const quoteSeq = useRef(0)

  // Reset per open; fetch the withdrawable balance. Funds live in spot
  // (one-balance policy) but Relay draws perps USDC, so withdrawable =
  // free spot + perps; submit() tops perps up from spot before executing.
  useEffect(() => {
    if (!open || !user) return
    setAmount("")
    setRecipient("")
    setQuote(null)
    setQuoteError(null)
    setPhase(null)
    setResult(null)
    setError(null)
    setWithdrawable(null)
    Promise.all([
      getPerpWithdrawable(user),
      getSpotUsdc(user),
      HYPEREVM_ENABLED ? readHyperEvmFunds(user as `0x${string}`).catch(() => null) : null,
      isHlActivated(user),
    ])
      .then(([perp, spot, evm, activated]) => {
        const core = perp + spot.free
        setCoreAvail(core)
        setActivationFee(!activated)
        const total = core + (evm ? Number(evm.usdc) / 1e6 : 0) - (activated ? 0 : 1)
        setWithdrawable((Math.floor(Math.max(0, total) * 100) / 100).toFixed(2))
      })
      .catch(() => setWithdrawable(null))
  }, [open, user])

  const amountNum = Number(amount)
  const addressOk = isAddress(recipient.trim())
  const amountOk =
    Number.isFinite(amountNum) &&
    amountNum >= MIN_WITHDRAW_USD &&
    (withdrawable === null || amountNum <= Number(withdrawable))
  const formOk = addressOk && amountOk && !!user

  // Debounced quote preview whenever the form becomes valid.
  useEffect(() => {
    setQuote(null)
    setQuoteError(null)
    if (!formOk || phase) return
    const seq = ++quoteSeq.current
    const t = setTimeout(() => {
      getWithdrawQuote({ user, recipient: recipient.trim(), amountUsd: amount })
        .then((q) => {
          if (quoteSeq.current === seq) setQuote(q)
        })
        .catch((e: Error) => {
          if (quoteSeq.current === seq) setQuoteError(e.message)
        })
    }, 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, recipient, formOk, user, phase])

  const submit = async () => {
    if (!wallet || !formOk || phase) return
    setError(null)
    const shown = quote
    try {
      // Fresh quote at click time so we never execute a stale one.
      setPhase("authorizing")
      // Part of it is in the HyperEVM wallet: move the gap to the trading side and wait for
      // the credit (a system tx, seconds), THEN quote: a Relay quote is short-lived
      // and the wait here must not eat its TTL.
      if (coreAvail !== null && amountNum > coreAvail) {
        // +1¢ rounding headroom, but never more than the wallet holds: on a Max withdrawal the
        // headroom pushed the transfer 1¢ past the balance and the ERC-20 reverted.
        // The $1 activation fee is due on the Hyperliquid side, so when it applies the gap
        // carries it across too — reserving it in Max alone would leave it on the EVM side.
        const evm = await readHyperEvmFunds(user as `0x${string}`)
        const want =
          BigInt(Math.ceil((amountNum - coreAvail + (activationFee ? 1 : 0)) * 1e6)) + BigInt(10_000)
        const gap = want > evm.usdc ? evm.usdc : want
        if (gap <= BigInt(0)) throw new Error("Your balance changed — close and reopen to refresh it.")
        await moveUsdcToHyperCore(wallet, gap)
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          const now = await Promise.all([getPerpWithdrawable(user), getSpotUsdc(user)])
            .then(([perp, spot]) => perp + spot.free)
            .catch(() => 0)
          if (now >= amountNum) break
        }
      }
      const fresh = await getWithdrawQuote({
        user,
        recipient: recipient.trim(),
        amountUsd: amount,
      })
      setQuote(fresh)
      // The user consented to the previewed numbers; if the outcome moved
      // meaningfully against them since then, ask for another click.
      if (shown && Number(fresh.receiveUsd) < Number(shown.receiveUsd) * 0.995) {
        setPhase(null)
        setError({
          message: "The quote changed — review the updated amount and try again.",
        })
        return
      }
      // Relay pulls perps USDC; funds live in spot — top perps up first. The activation fee is
      // assumed to come out of the ledger the transfer draws from (perps), so it rides along.
      await coverPerpsFromSpot(wallet, amountNum + (activationFee ? 1 : 0))
      const r = await executeWithdraw(wallet, fresh, setPhase)
      setResult(r)
    } catch (e) {
      console.error("withdraw failed", e)
      reportClientError("withdraw", e, wallet)
      // Trackable errors (funds moved or outcome uncertain) always surface
      // with the Relay link — even if the message resembles a rejection.
      if (e instanceof WithdrawTrackableError)
        setError({ message: e.message, requestId: e.requestId })
      else if (isActivationFeeError(e))
        {
          // See isActivationFeeError. The fee is paid from the USDC being withdrawn, so Max
          // learns it here: knock $1 off and let the user go again.
          const lower = Math.max(0, Number(withdrawable ?? amountNum) - 1)
          setWithdrawable((Math.floor(lower * 100) / 100).toFixed(2))
          setError({
            message:
              "Hyperliquid charges a one-time $1 fee on an account's first transfer out. Withdraw up to $" +
              lower.toFixed(2) +
              " now; the full amount is available from your next withdrawal.",
          })
        }
      else if (!isUserRejection(e))
        setError(explainSignError(e, "Withdrawal failed"))
      setPhase(null)
    }
  }

  // Once funds may have moved, keep the dialog up until we can show the
  // outcome (success or a trackable error) — no silent dismissal mid-flight.
  const busy = !!phase && !result
  const handleOpenChange = (o: boolean) => {
    if (!o && busy) return
    onOpenChange(o)
  }

  const description =
    "Withdraw USDC from your balance to any address on the Arbitrum network. Usually arrives within seconds."

  const body = result ? (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <HugeiconsIcon
        icon={CheckmarkCircle02Icon}
        className="size-10 text-yes"
      />
      <div className="text-sm">
        Sent{" "}
        <span className="font-heading tabular-nums">
          ${quote ? Number(quote.receiveUsd).toFixed(2) : amount}
        </span>{" "}
        to <span className="font-mono text-xs break-all">{recipient.trim()}</span>{" "}
        on Arbitrum.
      </div>
      <a
        href={`https://relay.link/transaction/${result.requestId}`}
        target="_blank"
        rel="noreferrer noopener"
        className="flex items-center gap-1 text-xs text-brand hover:underline"
      >
        View on Relay
        <HugeiconsIcon icon={LinkSquare02Icon} className="size-3.5" />
      </a>
    </div>
  ) : !user ? (
    <div className="rounded-xl border border-border bg-surface-2 px-3 py-6 text-center text-sm text-muted-foreground">
      Sign in to withdraw.
    </div>
  ) : (
    <>
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>Amount (USDC)</span>
          <button
            type="button"
            className="text-brand hover:underline cursor-pointer disabled:opacity-50"
            disabled={withdrawable === null || !!phase}
            onClick={() => withdrawable && setAmount(withdrawable)}
          >
            Max{" "}
            <span className="font-heading tabular-nums">
              {withdrawable !== null
                ? `$${Number(withdrawable).toFixed(2)}`
                : "…"}
            </span>
          </button>
        </div>
        <input
          inputMode="decimal"
          placeholder={`Min $${MIN_WITHDRAW_USD}`}
          value={amount}
          disabled={!!phase}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5 font-heading tabular-nums text-sm outline-none focus:border-brand"
        />
        {activationFee && (
          <div className="mt-1 text-xs text-muted-foreground">
            Hyperliquid keeps a one-time $1 account fee on your first transfer out — already left out of Max.
          </div>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>Destination address</span>
          <span className="rounded-full border border-border px-2 py-0.5">
            Arbitrum · USDC
          </span>
        </div>
        <input
          placeholder="0x…"
          value={recipient}
          disabled={!!phase}
          onChange={(e) => setRecipient(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5 font-mono text-xs outline-none focus:border-brand"
        />
        {recipient && !addressOk && (
          <div className="mt-1 text-xs text-no">Not a valid address.</div>
        )}
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-no/30 bg-no/10 px-3 py-2.5 text-xs leading-relaxed text-no">
        <HugeiconsIcon icon={Alert02Icon} className="size-4 shrink-0 mt-0.5" />
        <div>
          You&apos;ll receive{" "}
          <span className="font-semibold">USDC on Arbitrum One</span>. Transfers
          can&apos;t be reversed — double-check the address.
        </div>
      </div>

      {(quote || quoteError) && (
        <div className="space-y-1.5 px-1 text-sm">
          {quoteError ? (
            <div className="rounded-lg px-3 py-2 text-xs border bg-no/10 text-no border-no/30">
              {quoteError}
            </div>
          ) : (
            quote && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">You receive</span>
                  <span className="font-heading tabular-nums">
                    ${Number(quote.receiveUsd).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    Fee
                    {WITHDRAW_FEE_BPS > 0 && (
                      <>
                        {" ("}
                        <span className="font-heading tabular-nums">
                          {(WITHDRAW_FEE_BPS / 100)
                            .toFixed(2)
                            .replace(/\.?0+$/, "")}
                          %
                        </span>
                        {" + network)"}
                      </>
                    )}
                  </span>
                  <span className="font-heading tabular-nums">
                    ${quote.totalFeeUsd}
                  </span>
                </div>
              </>
            )
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
        disabled={!formOk || !quote || !!phase}
        className="btn-brand w-full h-10 font-semibold"
      >
        {phase ? PHASE_LABEL[phase] : "Withdraw"}
      </Button>
      <div className="flex flex-col items-center gap-2 pt-1">
        <p className="text-xs text-muted-foreground">
          Two wallet signatures — no gas needed.
        </p>
        <GetHelp />
        <a
          href="https://relay.link"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground shrink-0"
        >
          <span>Powered by</span>
          <RelayLogo className="h-3 w-auto" />
        </a>
      </div>
    </>
  )

  const shell = isDesktop ? (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[min(90vw,26rem)] -translate-x-1/2 -translate-y-1/2 space-y-3 rounded-2xl bg-popover p-6 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <Dialog.Title className="text-lg font-semibold">
            Withdraw USDC
          </Dialog.Title>
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
          <DrawerTitle className="text-lg font-semibold">
            Withdraw USDC
          </DrawerTitle>
          <DrawerDescription className="leading-relaxed">
            {description}
          </DrawerDescription>
        </DrawerHeader>
        <div className="space-y-3 overflow-y-auto p-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {body}
        </div>
      </DrawerContent>
    </Drawer>
  )

  return shell
}
