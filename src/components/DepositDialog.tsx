"use client"

import { useWallets } from "@privy-io/react-auth"
import { useCallback, useEffect, useRef, useState } from "react"
import { sweepPerpsToSpot } from "@/lib/hl-exchange"
import { QRCodeSVG } from "qrcode.react"
import {
  getDepositActivity,
  getDepositAddress,
  type DepositActivity,
  type DepositAddress,
} from "@/lib/relay"
import {
  DEPOSIT_CHAINS,
  DEFAULT_DEPOSIT_CHAIN,
  type DepositChain,
} from "@/lib/relay-deposit-core"
import { Button } from "@/components/ui/button"
import { Dialog } from "@base-ui/react/dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useMediaQuery } from "@/hooks/use-media-query"
import { daimoEnabled } from "@/lib/daimo-core"
import { DaimoDeposit } from "./DaimoDeposit"
import { DepositDirectDialog } from "./DepositDirectDialog"
import { GetHelp } from "./GetHelp"
import { RelayLogo } from "./RelayLogo"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"

interface DepositDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Relay's /requests/v3 response enum is: refund | waiting | depositing |
// failure | pending | submitted | success. `depositing` and `submitted` are NEW
// in v3 (they replaced v2's `delayed`); without an entry here they fell through
// to the fallback below and showed the raw API string to the user. `success` is
// unchanged, which matters — it also triggers the perps->spot sweep.
const STATUS_LABEL: Record<string, { text: string; tone: "pending" | "ok" | "bad" }> = {
  waiting: { text: "Waiting for deposit", tone: "pending" },
  depositing: { text: "Deposit detected…", tone: "pending" },
  pending: { text: "Bridging to Hyperliquid…", tone: "pending" },
  submitted: { text: "Bridging to Hyperliquid…", tone: "pending" },
  success: { text: "Deposited ✓", tone: "ok" },
  // Refunds land at the user's own address ON THE ORIGIN CHAIN — invisible
  // in-app except to Portfolio's RecoverFunds scanner, so point there.
  refund: { text: "Refunded — recover it in Portfolio", tone: "bad" },
  failure: { text: "Failed — recover it in Portfolio", tone: "bad" },
}

type Wallet = Parameters<typeof sweepPerpsToSpot>[0]

/** Two ways into the same Hyperliquid account. Relay (send USDC yourself to a
 * per-chain address) is the default tab. Daimo (exchange / bank / card where
 * available) sits behind the second tab but is preloaded — its session and
 * picker are ready the moment the tab is tapped, no "Preparing checkout…". */
export function DepositDialog({ open, onOpenChange }: DepositDialogProps) {
  const { wallets } = useWallets()
  const wallet =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0]

  const [directOpen, setDirectOpen] = useState(false)
  const isDesktop = useMediaQuery("(min-width: 1024px)")
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const openDirect = useCallback(() => setDirectOpen(true), [])

  // Daimo's picker is localised: exchanges, Tron and other chains everywhere,
  // card/Apple Pay/bank only in the countries whose fiat rails Daimo runs.
  // Never promise cards outright.
  const description = daimoEnabled
    ? "Send USDC yourself, or pay with an exchange balance, bank or card where available. It lands in your Hyperliquid account, usually within a minute."
    : "Pick a network, then send USDC from any exchange or wallet to the address below. It lands in your Hyperliquid account automatically, usually within a minute."

  const body = !wallet ? (
    <div className="rounded-xl border border-border bg-surface-2 px-3 py-6 text-center text-sm text-muted-foreground">
      Sign in to get your deposit address.
    </div>
  ) : daimoEnabled ? (
    // Both panels keepMounted (base-ui renders them on first paint): Daimo's
    // session and picker load in the background so the tab is instant, and
    // flipping between tabs neither mints a second session nor restarts the
    // Relay poll. Cost: one Daimo session per dialog open, even if unused.
    <Tabs defaultValue="relay">
      <TabsList className="w-full">
        <TabsTrigger value="relay">Send USDC</TabsTrigger>
        <TabsTrigger value="daimo">Exchange, card or bank</TabsTrigger>
      </TabsList>
      <TabsContent value="relay" keepMounted className="space-y-3">
        <RelayDeposit wallet={wallet} onDirect={openDirect} />
      </TabsContent>
      <TabsContent value="daimo" keepMounted className="space-y-3">
        <DaimoDeposit user={wallet.address} onClose={close} />
      </TabsContent>
    </Tabs>
  ) : (
    <RelayDeposit wallet={wallet} onDirect={openDirect} />
  )

  const content = (
    <>
      {body}
      <GetHelp className="w-full pt-1" />
    </>
  )

  const shell = isDesktop ? (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 max-h-[92dvh] w-[min(90vw,26rem)] -translate-x-1/2 -translate-y-1/2 space-y-3 overflow-y-auto rounded-2xl bg-popover p-6 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <Dialog.Title className="text-lg font-semibold">
            Deposit USDC
          </Dialog.Title>
          <Dialog.Description className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </Dialog.Description>
          {content}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  ) : (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="text-lg font-semibold">
            Deposit USDC
          </DrawerTitle>
          <DrawerDescription className="leading-relaxed">
            {description}
          </DrawerDescription>
        </DrawerHeader>
        <div className="space-y-3 overflow-y-auto p-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          {content}
        </div>
      </DrawerContent>
    </Drawer>
  )

  return (
    <>
      {shell}
      {directOpen && (
        <DepositDirectDialog open={directOpen} onOpenChange={setDirectOpen} />
      )}
    </>
  )
}

/** CEX-friendly deposit: the user's deposit address on a chain they pick; any
 * USDC sent there auto-bridges into their Hyperliquid account via Relay. No
 * wallet signing. Applies our app fee and shows live deposit status.
 *
 * Lives as long as the dialog is open (the panel is keepMounted): the address
 * fetch, the 5s activity poll and the sweep start on mount and stop when the
 * dialog closes, so there is nothing to gate on `open` here. */
function RelayDeposit({
  wallet,
  onDirect,
}: {
  wallet: Wallet
  onDirect: () => void
}) {
  const user = wallet.address

  const [chain, setChain] = useState<DepositChain>(DEFAULT_DEPOSIT_CHAIN)
  const [info, setInfo] = useState<DepositAddress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [activity, setActivity] = useState<DepositActivity[]>([])

  useEffect(() => {
    let stale = false
    setError(null)
    setInfo(null)
    setActivity([])
    getDepositAddress(user, chain)
      .then((i) => {
        if (!stale) setInfo(i)
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message)
      })
    return () => {
      stale = true
    }
  }, [user, chain])

  // Poll for incoming deposits while the panel is showing.
  const addr = info?.address
  const poll = useCallback(() => {
    if (!addr) return
    getDepositActivity(addr).then(setActivity)
  }, [addr])

  // Deposits bridge into the PERPS account; orders settle in spot. The user
  // is right here watching the status — sweep to spot the moment a deposit
  // succeeds so their first buy never hits a shortfall. Best-effort: the
  // pre-order ensureSpotUsdc covers anyone who missed this (e.g. closed tab).
  const swept = useRef(false)
  useEffect(() => {
    if (swept.current) return
    if (activity.some((a) => a.status === "success")) {
      swept.current = true
      sweepPerpsToSpot(wallet).catch(() => {})
    }
  }, [activity, wallet])
  useEffect(() => {
    if (!addr) return
    poll()
    const t = setInterval(poll, 5000)
    return () => clearInterval(t)
  }, [addr, poll])

  const copy = () => {
    if (!addr) return
    void navigator.clipboard.writeText(addr)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      {/* the dialog description is generic when Daimo shares the dialog; the
          "pick a network" instruction belongs to this pane */}
      {daimoEnabled && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Pick a network, then send USDC from any exchange or wallet to the
          address below.
        </p>
      )}
      <div
        role="group"
        aria-label="Choose deposit network"
        className="flex flex-wrap gap-1.5"
      >
        {DEPOSIT_CHAINS.map((c) => (
          <button
            key={c.chainId}
            type="button"
            onClick={() => setChain(c)}
            aria-pressed={c.chainId === chain.chainId}
            className={
              c.chainId === chain.chainId
                ? "cursor-pointer rounded-full border border-brand bg-brand/10 px-3 py-1 text-xs font-semibold text-brand"
                : "cursor-pointer rounded-full border border-border bg-surface-2 px-3 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
            }
          >
            {c.label}
          </button>
        ))}
      </div>
      {error ? (
        <div className="rounded-lg px-3 py-2 text-xs border bg-no/10 text-no border-no/30">
          {error}
        </div>
      ) : !info ? (
        <div className="rounded-xl border border-border bg-surface-2 px-3 py-10 text-center text-sm text-muted-foreground">
          Generating your deposit address…
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2 rounded-xl border border-no/30 bg-no/10 px-3 py-2.5 text-xs leading-relaxed text-no">
            <HugeiconsIcon
              icon={Alert02Icon}
              className="size-4 shrink-0 mt-0.5"
            />
            <div>
              Send <span className="font-semibold">USDC on {chain.name}</span> only.
              Any other token or network sent here may be lost.
            </div>
          </div>

          <div className="flex flex-col items-center gap-3">
            <div className="rounded-xl bg-white p-3">
              <QRCodeSVG value={addr!} size={168} marginSize={0} level="M" />
            </div>
            <div className="w-full">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span>Your deposit address</span>
                <span className="rounded-full border border-border px-2 py-0.5">
                  {chain.label} · USDC
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2.5">
                <span className="min-w-0 flex-1 font-mono text-xs break-all">
                  {addr}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={copy}
                  className="shrink-0 text-xs font-semibold gap-1.5"
                >
                  <HugeiconsIcon
                    icon={copied ? Tick02Icon : Copy01Icon}
                    className="size-3.5"
                  />
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-1.5 px-1 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Fee</span>
              <span className="font-heading tabular-nums">
                {info.feeBps > 0 ? `${info.feePct}%` : "None"}
              </span>
            </div>
            {info.sponsored && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Bridge fees</span>
                <span className="font-heading text-yes">Covered by us</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Minimum</span>
              <span className="font-heading tabular-nums">
                ${info.minUsd}
              </span>
            </div>
          </div>

          {activity.length > 0 && (
            <div className="space-y-1.5 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-xs">
              <div className="text-muted-foreground">Recent deposits</div>
              {activity.map((a, i) => {
                const s = STATUS_LABEL[a.status] ?? {
                  text: a.status,
                  tone: "pending" as const,
                }
                return (
                  <div key={i} className="flex items-center justify-between">
                    <span
                      className={
                        s.tone === "ok"
                          ? "text-yes"
                          : s.tone === "bad"
                            ? "text-no"
                            : "text-foreground"
                      }
                    >
                      {s.text}
                    </span>
                    {a.amountUsd && (
                      <span className="font-heading tabular-nums text-muted-foreground">
                        ${Number(a.amountUsd).toFixed(2)}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      <div className="flex flex-col items-center gap-2 pt-1">
        <p className="text-xs text-muted-foreground">
          Already have USDC on Hyperliquid?{" "}
          <button
            type="button"
            onClick={onDirect}
            className="text-brand hover:underline cursor-pointer"
          >
            Deposit directly
          </button>
        </p>
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
}
