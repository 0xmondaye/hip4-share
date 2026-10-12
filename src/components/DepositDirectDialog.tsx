"use client"

import { useWallets } from "@privy-io/react-auth"
import { useState } from "react"
import { QRCodeSVG } from "qrcode.react"
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
import { GetHelp } from "./GetHelp"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"

interface DepositDirectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Receive USDC straight into the Hyperliquid trading account (HyperCore) by
 * sending on the Hyperliquid network — scoped to transfers from ANOTHER
 * HYPERLIQUID ACCOUNT only. CEXs rarely offer HyperCore USDC withdrawals;
 * suggesting this flow to CEX users made them pick the nearest network their
 * exchange did offer (Arbitrum, HyperEVM) and strand funds — CEX users belong
 * in the Relay bridge dialog. Wrong-network sends land at the user's own
 * address, so Portfolio's RecoverFunds scanner can bring them back. */
export function DepositDirectDialog({
  open,
  onOpenChange,
}: DepositDirectDialogProps) {
  const { wallets } = useWallets()
  const wallet =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0]
  const addr = wallet?.address ?? ""

  const [copied, setCopied] = useState(false)
  const copy = () => {
    if (!addr) return
    void navigator.clipboard.writeText(addr)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const isDesktop = useMediaQuery("(min-width: 1024px)")
  const description =
    "Send USDC from another Hyperliquid account to your address below. Coming from an exchange or another chain? Use the regular deposit instead."

  const body = (
    <>
      <div className="flex items-start gap-2 rounded-xl border border-no/30 bg-no/10 px-3 py-2.5 text-xs leading-relaxed text-no">
        <HugeiconsIcon icon={Alert02Icon} className="size-4 shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold">Hyperliquid network only.</span> Do
          not send on HyperEVM, Arbitrum, or any other chain to this address —
          those funds won&apos;t credit your trading balance. Already sent on
          the wrong network? Open your{" "}
          <span className="font-semibold">Portfolio</span> — we detect
          stranded USDC and recover it for you.
        </div>
      </div>

      {addr ? (
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-xl bg-white p-3">
            <QRCodeSVG value={addr} size={168} marginSize={0} level="M" />
          </div>
          <div className="w-full">
            <div className="text-xs text-muted-foreground mb-1">
              Your Hyperliquid address
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
      ) : (
        <div className="rounded-xl border border-border bg-surface-2 px-3 py-6 text-center text-sm text-muted-foreground">
          Sign in to see your deposit address.
        </div>
      )}
      <GetHelp className="w-full pt-1" />
    </>
  )

  if (isDesktop) {
    return (
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
          <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[min(90vw,26rem)] -translate-x-1/2 -translate-y-1/2 space-y-3 rounded-2xl bg-popover p-6 text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <Dialog.Title className="text-lg font-semibold">
              Deposit on Hyperliquid
            </Dialog.Title>
            <Dialog.Description className="text-sm leading-relaxed text-muted-foreground">
              {description}
            </Dialog.Description>
            {body}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange} showSwipeHandle>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="text-lg font-semibold">
            Deposit on Hyperliquid
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
}
