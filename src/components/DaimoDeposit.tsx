"use client"

// Card / Apple Pay / exchange / any-chain deposit into the user's Hyperliquid
// account, via Daimo Pay's hosted checkout in an inline iframe. The session
// pins the destination server-side (/api/daimo/deposit-session); this pane
// only shows the flow and notices when it finishes. DepositDialog owns the
// shell; this is the second tab, mounted from the start so it is ready the
// moment it is tapped.
//
// No status polling: Daimo's own UI narrates progress inside the iframe, and
// the delivered USDC shows up through the app's normal balance polling. If
// the completion message never arrives the deposit still lands — the user
// just closes the dialog.

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { daimoWebviewUrl } from "@/lib/daimo-core"
import { privyAuthHeaders } from "@/lib/privy-tokens"

interface DaimoDepositProps {
  /** the user's Hyperliquid (Privy EVM) address — the deposit recipient */
  user: string
  /** Daimo's own dismiss. It is the primary content, so the dialog goes too. */
  onClose: () => void
}

type State =
  | { step: "loading" }
  | { step: "ready"; sessionId: string; clientSecret: string }
  | { step: "done" }
  | { step: "error"; message: string }

// Until Daimo reports its real height: tall enough for the picker, short
// enough that a phone drawer still shows the tabs above it.
const MIN_HEIGHT = 384

export function DaimoDeposit({ user, onClose }: DaimoDepositProps) {
  const [state, setState] = useState<State>({ step: "loading" })
  const [height, setHeight] = useState<number | null>(null)

  // One session per mount — abandoned ones expire on Daimo's side (~1h). The
  // pane stays mounted while the user looks at the Send USDC tab (keepMounted
  // in DepositDialog), so switching tabs does not mint another.
  useEffect(() => {
    let stale = false
    setState({ step: "loading" })
    // header for localStorage-mode sessions; a custom-auth-domain session
    // rides as a cookie the same-origin fetch sends anyway
    privyAuthHeaders()
      .then((auth) =>
        fetch("/api/daimo/deposit-session", {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ user }),
        }),
      )
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as {
          sessionId?: string
          clientSecret?: string
          message?: string
        }
        if (!res.ok || !json.sessionId || !json.clientSecret)
          throw new Error(json.message ?? `Deposit setup failed (${res.status})`)
        if (!stale)
          setState({ step: "ready", sessionId: json.sessionId, clientSecret: json.clientSecret })
      })
      .catch((e: Error) => {
        if (!stale) setState({ step: "error", message: e.message })
      })
    return () => {
      stale = true
    }
  }, [user])

  // Daimo's iframe posts {source:"daimo-pay", type, payload} — contract proven
  // in the React Native app. `contentHeightChanged` is what layout=embed adds:
  // the frame is sized to Daimo's content instead of a fixed viewport slice.
  // Only listen while the checkout is showing.
  useEffect(() => {
    if (state.step !== "ready") return
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== "https://daimo.com") return
      const d = e.data as
        | { source?: string; type?: string; payload?: { height?: number } }
        | null
      if (d?.source !== "daimo-pay") return
      if (d.type === "paymentCompleted") setState({ step: "done" })
      else if (d.type === "modalClosed") onClose()
      else if (d.type === "contentHeightChanged") {
        const h = d.payload?.height
        if (typeof h === "number" && h > 0) setHeight(Math.ceil(h))
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [state.step, onClose])

  if (state.step === "loading")
    return (
      <div className="rounded-xl border border-border bg-surface-2 px-3 py-10 text-center text-sm text-muted-foreground">
        Preparing checkout…
      </div>
    )
  if (state.step === "error")
    return (
      <div className="rounded-lg border border-no/30 bg-no/10 px-3 py-2 text-xs text-no">
        {state.message}. Use <span className="font-semibold">Send USDC</span> instead.
      </div>
    )
  if (state.step === "done")
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-yes/30 bg-yes/10 px-3 py-4 text-center text-sm text-yes">
          Payment received — your balance updates once the deposit settles,
          usually within a minute.
        </div>
        <Button className="w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    )
  return (
    <>
      <iframe
        src={daimoWebviewUrl(state.sessionId, state.clientSecret)}
        title="Daimo deposit"
        style={{ height: height ?? MIN_HEIGHT }}
        className="w-full rounded-xl transition-[height] duration-200"
        // Apple Pay and card processors load off-daimo.com origins, identity
        // checks use the camera, Stripe Link opens popups — allow broadly and
        // never sandbox this frame.
        // clipboard-write is NOT optional: the deposit screen's whole job is
        // handing over a one-time address and an exact amount, and its copy
        // buttons call navigator.clipboard, which a cross-origin frame is
        // denied by default. Without this they fail silently.
        allow="payment *; camera *; microphone *; clipboard-write *"
      />
      <p className="px-1 text-xs text-muted-foreground">
        Depositing to a brand-new Hyperliquid account? Hyperliquid takes $1
        out of the first deposit.
      </p>
    </>
  )
}
