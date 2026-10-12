export class SessionExpiredError extends Error {
  constructor() {
    super("Your session has expired — please log in again.");
    this.name = "SessionExpiredError";
  }
}

/** Fire-and-forget beacon so signer failures reach server logs (Vercel) —
 * they otherwise die in the affected user's browser console. No PII beyond
 * wallet address. */
export function reportClientError(
  flow: string,
  e: unknown,
  wallet?: { address?: string; walletClientType?: string },
) {
  const chain: string[] = [];
  let c: unknown = e;
  for (; c instanceof Error; c = c.cause) chain.push(`${c.name}: ${c.message}`);
  if (c != null) chain.push(typeof c === "string" ? c : JSON.stringify(c));
  fetch("/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      flow,
      chain,
      walletClientType: wallet?.walletClientType,
      address: wallet?.address,
    }),
    keepalive: true,
  }).catch(() => {});
}

/** Map a (possibly nktkas-wrapped) signer error to an actionable message.
 * Walks the `cause` chain for known failure signatures; falls back to the
 * joined chain so unknown errors still self-diagnose. */
export function explainSignError(
  e: unknown,
  fallback = "Something went wrong — try again.",
): { message: string; sessionExpired: boolean; reload?: boolean } {
  const messages: string[] = [];
  let c: unknown = e;
  for (; c instanceof Error; c = c.cause) messages.push(c.message);
  // Privy's iframe/modal flows can reject with plain objects or strings —
  // without this, users saw only the generic nktkas wrapper text and every
  // report was undiagnosable.
  if (c != null)
    messages.push(typeof c === "string" ? c : JSON.stringify(c));
  const all = messages.filter(Boolean).join(" — ");
  // Privy's embedded-wallet iframe (privy.gambitapp.io) is a Next.js app.
  // When Privy redeploys while a user has the page open, the iframe's lazy
  // chunks 404 and the signer throws ChunkLoadError, which viem wraps as
  // "An unknown RPC error occurred … Details: Loading chunk N failed". No
  // tx was sent. Only a page reload swaps in the fresh iframe.
  if (/loading chunk \d+ failed|ChunkLoadError/i.test(all))
    return {
      message:
        "The wallet service was updated while this page was open — reload the page and try again. Nothing was sent.",
      sessionExpired: false,
      reload: true,
    };
  // Privy: embedded-wallet iframe refused to connect (logged out / stale auth)
  if (/must be authenticated|session.*expired/i.test(all))
    return {
      message: "Your session has expired — please log in again.",
      sessionExpired: true,
    };
  // External wallet: active account isn't the one connected to the app
  if (/not been authorized|unauthorized/i.test(all))
    return {
      message:
        "Your wallet is on a different account — switch it back to the connected address and retry.",
      sessionExpired: false,
    };
  // Privy rate-limits its own session/signing API. Transient, upstream, and
  // their copy ("Please wait to try again") reads like a dead end on a money
  // banner — say what to do instead.
  if (/too many requests|rate.?limit/i.test(all))
    return {
      message: "Too busy right now — wait a few seconds and retry.",
      sessionExpired: false,
    };
  // Wallet switched networks between deriving the chain id and signing
  if (/chainid must match/i.test(all))
    return {
      message: "Your wallet switched networks mid-signing — retry.",
      sessionExpired: false,
    };
  return { message: all || fallback, sessionExpired: false };
}
