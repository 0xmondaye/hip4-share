"use client"

// Crossmint onramp checkout for a pack pull: card in, USDC delivered on-chain
// to the user's own pack wallet. On delivery the caller re-runs the pull —
// doPull's skip-bridge check sees the funded wallet and goes straight to the
// Slabz purchase, so this dialog never touches HL. Loaded via next/dynamic
// only when opened. Unlike Coinflow there's no wallet shim: Crossmint's
// component only needs orderId + clientSecret; the recipient wallet was
// pinned server-side at order creation.

import { useEffect, useRef, useState } from "react"
import {
  CrossmintProvider,
  CrossmintCheckoutProvider,
  CrossmintEmbeddedCheckout,
  useCrossmintCheckout,
} from "@crossmint/client-sdk-react-ui"
import { Dialog } from "@base-ui/react/dialog"
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana"
import { CROSSMINT_CLIENT_KEY } from "@/lib/crossmint-core"
import { getOnrampOrder } from "@/lib/gacha-quotes"
import { usdcUnits6 } from "@/lib/solana-client"
import { usd } from "@/lib/slabz"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface CrossmintCheckoutProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  packId: string
  count: number
  solWallet: ConnectedStandardSolanaWallet
  /** USDC for the pull landed in the pack wallet — resume the pull. The
   *  dialog is already closed when this fires. */
  onFunded: () => void
}

type State =
  | { step: "loading" }
  | { step: "ready"; orderId: string; clientSecret: string; subtotalCents: number; totalCents: number }
  | { step: "delivering" }
  | { step: "slow" }
  | { step: "error"; message: string }

/** Inside CrossmintCheckoutProvider: watches the order and fires once the
 *  payment/delivery completes. */
function PhaseListener({ onCompleted }: { onCompleted: () => void }) {
  const { order } = useCrossmintCheckout()
  const doneRef = useRef(false)
  useEffect(() => {
    if (order?.phase === "completed" && !doneRef.current) {
      doneRef.current = true
      onCompleted()
    }
  }, [order, onCompleted])
  return null
}

export function CrossmintCheckout({
  open,
  onOpenChange,
  packId,
  count,
  solWallet,
  onFunded,
}: CrossmintCheckoutProps) {
  const [state, setState] = useState<State>({ step: "loading" })

  // one order per open — server re-reads the fresh Slabz price each time.
  // Unpaid orders simply expire on Crossmint's side.
  useEffect(() => {
    if (!open) return
    let stale = false
    setState({ step: "loading" })
    getOnrampOrder(packId, solWallet.address, count)
      .then((r) => {
        if (!stale) setState({ step: "ready", ...r })
      })
      .catch((e: Error) => {
        if (!stale) setState({ step: "error", message: e.message })
      })
    return () => {
      stale = true
    }
  }, [open, packId, solWallet.address, count])

  // funded threshold must match doPull's skip-bridge check (absolute balance
  // ≥ bare price) or the resumed pull would bridge from HL on top of the card
  const subtotalRef = useRef(0)
  if (state.step === "ready") subtotalRef.current = state.subtotalCents

  async function onCompleted() {
    setState({ step: "delivering" })
    const need = BigInt(subtotalRef.current) * BigInt(10_000)
    const deadline = Date.now() + 3 * 60_000
    while (Date.now() < deadline) {
      const units = await usdcUnits6(solWallet.address).catch(() => null)
      if (units != null && units >= need) {
        onOpenChange(false)
        onFunded()
        return
      }
      await sleep(2500)
    }
    // payment settled but the on-chain delivery is lagging — the money is not
    // lost: the next Pull re-checks the wallet and resumes without recharging
    setState({ step: "slow" })
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        // never let an accidental backdrop click kill the wait — the poll is
        // the thing that resumes the pull after the card was charged
        if (!o && state.step === "delivering") return
        onOpenChange(o)
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[92dvh] w-[min(94vw,28rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl bg-popover p-4 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <Dialog.Title className="text-lg font-semibold">
            Pay with card
            {state.step === "ready" && (
              <span className="ml-2 font-normal text-muted-foreground">
                {usd(state.totalCents)}
              </span>
            )}
          </Dialog.Title>
          {state.step === "loading" && (
            <p className="py-10 text-center text-sm text-muted-foreground">Preparing checkout…</p>
          )}
          {state.step === "error" && (
            <p className="py-6 text-center text-sm text-no">{state.message}</p>
          )}
          {state.step === "delivering" && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Payment received — delivering funds to your pack wallet…
            </p>
          )}
          {state.step === "slow" && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Payment received. Delivery is taking longer than usual — hit Pull
              again in a minute and it resumes without charging you twice.
            </p>
          )}
          {state.step === "ready" && (
            <div className="min-h-0 overflow-y-auto rounded-xl bg-white">
              <CrossmintProvider apiKey={CROSSMINT_CLIENT_KEY}>
                <CrossmintCheckoutProvider>
                  <PhaseListener onCompleted={onCompleted} />
                  <CrossmintEmbeddedCheckout
                    orderId={state.orderId}
                    clientSecret={state.clientSecret}
                    payment={{
                      crypto: { enabled: false },
                      fiat: { enabled: true },
                      defaultMethod: "fiat",
                    }}
                  />
                </CrossmintCheckoutProvider>
              </CrossmintProvider>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
