"use client"

// Coinflow card checkout for a pack pull: card/Apple Pay/Google Pay in, USDC
// delivered on-chain to the user's own pack wallet. On delivery the caller
// re-runs the pull — doPull's skip-bridge check sees the funded wallet and
// goes straight to the Slabz purchase, so this dialog never touches HL.
// Loaded via next/dynamic only when opened: @solana/web3.js is a heavy peer
// dep the SDK needs (legacy Connection/PublicKey), used nowhere else.

import { useEffect, useMemo, useRef, useState } from "react"
import { CoinflowPurchase } from "@coinflowlabs/react"
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js"
import { Dialog } from "@base-ui/react/dialog"
import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana"
import { COINFLOW_ENV, COINFLOW_MERCHANT_ID } from "@/lib/coinflow-core"
import { getCardCheckoutJwt } from "@/lib/gacha-quotes"
import type { SignSolanaMessage, SignSolanaTx } from "@/lib/gacha-bridge"
import { RPC_URL, sendSignedTx, usdcUnits6 } from "@/lib/solana-client"
import { bytesToB64, usd } from "@/lib/slabz"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface CardCheckoutProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  packId: string
  count: number
  solWallet: ConnectedStandardSolanaWallet
  sign: SignSolanaTx
  signMessage: SignSolanaMessage
  /** USDC for the pull landed in the pack wallet — resume the pull. The
   *  dialog is already closed when this fires. */
  onFunded: () => void
}

type State =
  | { step: "loading" }
  | { step: "ready"; jwtToken: string; subtotalCents: number; totalCents: number }
  | { step: "delivering" }
  | { step: "slow" }
  | { step: "error"; message: string }

export function CardCheckout({
  open,
  onOpenChange,
  packId,
  count,
  solWallet,
  sign,
  signMessage,
  onFunded,
}: CardCheckoutProps) {
  const [state, setState] = useState<State>({ step: "loading" })
  const [iframeHeight, setIframeHeight] = useState(480)

  // one JWT per open — server re-reads the fresh Slabz price each time
  useEffect(() => {
    if (!open) return
    let stale = false
    setState({ step: "loading" })
    getCardCheckoutJwt(packId, solWallet.address, count)
      .then((r) => {
        if (!stale)
          setState({
            step: "ready",
            jwtToken: r.jwtToken,
            subtotalCents: r.subtotalCents,
            totalCents: r.totalCents,
          })
      })
      .catch((e: Error) => {
        if (!stale) setState({ step: "error", message: e.message })
      })
    return () => {
      stale = true
    }
  }, [open, packId, solWallet.address, count])

  const connection = useMemo(() => new Connection(RPC_URL, "confirmed"), [])
  // Coinflow wants a wallet-adapter shape; bridge it to the headless Privy
  // signer closures. A plain USDC delivery never calls sendTransaction (the
  // delivery tx is Coinflow's own), but implement it for real — a throwing
  // stub would strand the edge flows that do route a tx through the wallet.
  const wallet = useMemo(
    () => ({
      publicKey: new PublicKey(solWallet.address),
      sendTransaction: async (tx: { serialize: () => Uint8Array | Buffer }) => {
        const bytes =
          tx instanceof VersionedTransaction
            ? tx.serialize()
            : (tx as { serialize: (o: object) => Buffer }).serialize({
                requireAllSignatures: false,
                verifySignatures: false,
              })
        const signed = await sign(new Uint8Array(bytes))
        return sendSignedTx(bytesToB64(signed))
      },
      signMessage: (m: Uint8Array) => signMessage(m),
    }),
    [solWallet.address, sign, signMessage],
  )

  // funded threshold must match doPull's skip-bridge check (absolute balance
  // ≥ bare price) or the resumed pull would bridge from HL on top of the card
  const subtotalRef = useRef(0)
  if (state.step === "ready") subtotalRef.current = state.subtotalCents

  async function onSuccess() {
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
          <div
            className="min-h-0 overflow-y-auto rounded-xl bg-white"
            style={{ height: iframeHeight }}
          >
            <CoinflowPurchase
              merchantId={COINFLOW_MERCHANT_ID}
              env={COINFLOW_ENV}
              blockchain="solana"
              wallet={wallet}
              connection={connection}
              jwtToken={state.jwtToken}
              onSuccess={onSuccess}
              handleHeightChange={(h) => {
                const n = Number(h)
                if (Number.isFinite(n) && n > 0) setIframeHeight(Math.min(n, 640))
              }}
            />
          </div>
        )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
