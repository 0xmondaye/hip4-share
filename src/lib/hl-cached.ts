import { unstable_cache } from "next/cache";
import { getAllMids, getOutcomeMeta } from "./hyperliquid";

// HL rate-limits per IP and Vercel egress IPs are shared, so per-request
// no-store fetches routinely 429 and error the whole page ("Markets are
// busy right now"). Cache the two globals every page render needs — one
// upstream call serves all concurrent visitors, and unstable_cache
// revalidates in the background so a failed refresh keeps serving the
// last good value instead of throwing. Clients go live over websocket
// after hydration, so a few seconds of staleness is invisible.
// Server-only (unstable_cache): don't import from client components.

export const cachedOutcomeMeta = unstable_cache(
  () => getOutcomeMeta(),
  ["hl-outcome-meta"],
  { revalidate: 30 },
);

export const cachedAllMids = unstable_cache(
  () => getAllMids(),
  ["hl-all-mids"],
  { revalidate: 2 },
);
