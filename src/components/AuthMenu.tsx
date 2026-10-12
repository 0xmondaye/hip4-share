"use client";

import { useLogin, useLogout, usePrivy, useWallets } from "@privy-io/react-auth";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { getAllMids, getBalanceParts } from "@/lib/hyperliquid";
import { HYPEREVM_ENABLED, readHyperEvmFunds, usd6 } from "@/lib/hyperevm-funds";
import { positionsValue } from "@/lib/types";
import { HugeiconsIcon } from "@hugeicons/react";
import { LinkSquare02Icon } from "@hugeicons/core-free-icons";

// Lazy: pulls qrcode/relay — keep it out of the global header bundle until
// the user actually opens the deposit dialog.
const DepositDialog = dynamic(
  () => import("./DepositDialog").then((m) => m.DepositDialog),
  { ssr: false },
);

const WithdrawDialog = dynamic(
  () => import("./WithdrawDialog").then((m) => m.WithdrawDialog),
  { ssr: false },
);

const SendHypeDialog = dynamic(
  () => import("./SendHypeDialog").then((m) => m.SendHypeDialog),
  { ssr: false },
);

// ponytail: read the gacha money lock straight out of localStorage rather than
// importing gacha-bridge — the global header must not pull the Solana bridge in
// just to know the balance is mid-move. The lock is held for exactly the ops
// that shift money between HL and the pack wallet (pull, sell-back, the sweep
// home from Solana), which is when this number is stale.
//
// Capped well under takeMoneyLock's own 20-minute staleness rule on purpose: a
// tab killed mid-pull leaves the lock behind, and a spinner that spins for 20
// minutes with no explanation is worse than a stale-but-honest number. Anything
// genuinely still in flight is narrated on the pull surface itself.
const SPIN_MAX_MS = 2 * 60_000;
const moneyMoving = () => {
  try {
    const t = Number(localStorage.getItem("gacha:busy") ?? 0);
    return !!t && Date.now() - t < SPIN_MAX_MS;
  } catch {
    return false;
  }
};

const MovingSpinner = ({ announce = false }: { announce?: boolean }) => (
  <>
    <span
      aria-hidden
      className="size-3 shrink-0 animate-spin rounded-full border-2 border-brand border-t-transparent"
    />
    {announce && (
      <span role="status" className="sr-only">
        Balance updating
      </span>
    )}
  </>
);

export function AuthMenu() {
  const pathname = usePathname();
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin();
  const { logout } = useLogout();
  const { wallets } = useWallets();
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [sendHypeOpen, setSendHypeOpen] = useState(false);
  // HYPE the app never asked for (a guest sent it here from an exchange). Not part of the
  // balance -- the app is USDC-denominated -- but theirs to send on, so the menu offers that
  // the moment there is more than gas dust.
  const [hype, setHype] = useState(0);
  const [balance, setBalance] = useState<string | null>(null);
  // The same key's OTHER ledger: native USDC in the HyperEVM wallet, where Cellar pulls are
  // paid from and sellbacks are paid to. Folded into the one number the user sees -- every
  // spend path moves money across on its own, so the split is not theirs to manage.
  const [evmUsdc, setEvmUsdc] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const wallet = wallets.find(
    (w) => w.walletClientType === "privy",
  ) ?? wallets[0];
  const addr = wallet?.address ?? "";

  // Hyperliquid account value — shown in the header button and the
  // dropdown, so it loads on sign-in and refreshes every 30s (paused
  // while the tab is hidden), plus on dropdown open.
  const loadBalance = useCallback(async () => {
    if (!addr) return;
    try {
      // One number for CEX users: spot USDC (where funds live) + perps
      // account value (where deposits land until the first order sweeps)
      // + current value of outcome shares, so buying doesn't read as the
      // balance shrinking.
      // getBalanceParts throws on a non-200 (and retries 429s): a raw fetch
      // would parse an error body into 0 and show a funded account as $0.00.
      const [parts, mids, evm] = await Promise.all([
        getBalanceParts(addr),
        getAllMids({ cache: "no-store" }),
        HYPEREVM_ENABLED
          ? readHyperEvmFunds(addr as `0x${string}`).catch(() => null)
          : null,
      ]);
      if (evm) setEvmUsdc(usd6(evm.usdc));
      setHype(parts.spotHype + (evm ? Number(evm.hype) / 1e18 : 0));
      setBalance(
        (
          parts.perpsEquity +
          parts.spotUsdc.total +
          positionsValue(parts.positions, mids)
        ).toFixed(2),
      );
    } catch {
      // ponytail: keep the last good number — wiping it on a transient
      // failure is the same lie as showing 0.
    }
  }, [addr]);

  useEffect(() => {
    if (!authenticated || !addr) return;
    loadBalance();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") loadBalance();
    }, 30_000);
    return () => clearInterval(id);
  }, [authenticated, addr, loadBalance]);

  // Spinner while a gacha money op runs, and one re-read on the falling edge —
  // waiting out the 30s poll after a payout landed showed the old number.
  useEffect(() => {
    if (!authenticated) return;
    let prev = false;
    const id = setInterval(() => {
      const now = moneyMoving();
      if (prev && !now) loadBalance();
      prev = now;
      setMoving(now);
    }, 2000);
    return () => clearInterval(id);
  }, [authenticated, loadBalance]);

  if (!ready) {
    return <Skeleton className="h-9 w-24 rounded-lg" />;
  }

  if (!authenticated) {
    return (
      <Button
        onClick={() => login()}
        className="btn-brand h-9 px-4 font-semibold"
      >
        Sign in
      </Button>
    );
  }

  const short = addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";
  const email = user?.email?.address ?? user?.google?.email ?? null;

  return (
    <div className="flex items-center gap-2">
      <Button
        onClick={() => setDepositOpen(true)}
        className="btn-brand h-9 px-4 font-semibold"
      >
        Deposit
      </Button>
      {/* desktop: Portfolio + balance share one outlined pill, packs.com style;
          the trigger drops its own border/bg there so the wrapper draws the pill */}
      <div className="flex items-center lg:h-9 lg:glass lg:rounded-full">
        <Link
          href="/portfolio"
          className={`hidden lg:flex items-center h-full px-3.5 rounded-full text-base font-semibold transition-colors hover:bg-white/5 active:translate-y-px ${
            pathname.startsWith("/portfolio")
              ? "text-brand"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Portfolio
        </Link>
        <span aria-hidden className="hidden lg:block w-px h-4 bg-white/10" />
        <DropdownMenu
        onOpenChange={(open) => {
          if (open) loadBalance();
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="h-9 px-3.5 text-xs font-mono rounded-full max-lg:glass lg:hover:bg-white/5 lg:aria-expanded:bg-white/5"
            />
          }
        >
          {moving ? (
            <MovingSpinner announce />
          ) : (
            <span className="size-1.5 rounded-full bg-yes" />
          )}
          <span className="tabular-nums">
            {balance !== null
              ? `$${(Number(balance) + Number(evmUsdc ?? 0)).toFixed(2)}`
              : short}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="font-normal">
            {email && <div className="text-sm truncate">{email}</div>}
            <div className="text-xs text-muted-foreground">Balance</div>
            <div className="flex items-center gap-2 text-xl font-heading tabular-nums">
              {balance !== null
                ? `$${(Number(balance) + Number(evmUsdc ?? 0)).toFixed(2)}`
                : "…"}
              {moving && <MovingSpinner />}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setDepositOpen(true)}>
              Deposit USDC
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setWithdrawOpen(true)}>
              Withdraw USDC
            </DropdownMenuItem>
            {hype > 0.01 && (
              <DropdownMenuItem onClick={() => setSendHypeOpen(true)}>
                Send HYPE
                <span className="ml-auto font-heading tabular-nums text-xs text-muted-foreground">
                  {hype.toFixed(2)}
                </span>
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => navigator.clipboard.writeText(addr)}
            >
              Copy address
            </DropdownMenuItem>
            <DropdownMenuItem
              render={
                <a
                  href={`https://app.hyperliquid.xyz/explorer/address/${addr}`}
                  target="_blank"
                  rel="noreferrer noopener"
                />
              }
            >
              View on Hyperliquid Explorer
              <HugeiconsIcon
                icon={LinkSquare02Icon}
                className="ml-auto size-3.5"
              />
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => logout()}>
              Sign out
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>

      {depositOpen && (
        <DepositDialog open={depositOpen} onOpenChange={setDepositOpen} />
      )}
      {withdrawOpen && (
        <WithdrawDialog open={withdrawOpen} onOpenChange={setWithdrawOpen} />
      )}
      {sendHypeOpen && (
        <SendHypeDialog open={sendHypeOpen} onOpenChange={setSendHypeOpen} />
      )}

    </div>
  );
}
