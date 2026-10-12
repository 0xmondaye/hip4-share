// Pure parse of Relay's GET /requests/v3 into what the Deposit dialog renders.
// No I/O — tested from node in relay-activity.test.mjs.

export interface DepositActivity {
  /**
   * Relay request status. The v3 RESPONSE enum is seven values:
   * refund | waiting | depositing | failure | pending | submitted | success.
   * (v2's `delayed` is gone; the status QUERY filter still accepts only five,
   * which is why we never filter on it.) Left as a plain string: the dialog
   * maps known values and falls back for the rest, so a future addition
   * degrades to a neutral label instead of throwing.
   */
  status: string
  amountUsd?: string
  createdAt?: string
}

/**
 * Where the USD amount lives — the one genuinely breaking change from v2.
 *
 * v2 had it at `data.metadata.currencyIn.amountUsd`. v3 DELETES `data.metadata`
 * ("consolidate into `data.route`"), so that path returns undefined and the
 * amount silently renders blank. v3's path is
 * `data.route.actual.origin.inputCurrency.amountUsd`, with the migration guide's
 * own instruction to "fall back to `data.route.quoted`" when actual is absent.
 *
 * The `actual` → `quoted` order matters and is not cosmetic: for an OPEN deposit
 * address the quoted amount is not what the user actually pushed, so quoted is a
 * best-effort placeholder while the request is still waiting/depositing, and
 * `actual` must win the moment it exists. Whether `actual` is populated for a
 * pending open-address request is NOT documented and was not verifiable without
 * a live key — hence the fallback rather than a single path.
 *
 * The legacy v2 paths are read last so a response from either version parses.
 */
export function activityAmountUsd(data: unknown): string | undefined {
  const d = data as
    | {
        route?: {
          actual?: { origin?: { inputCurrency?: { amountUsd?: unknown } } }
          quoted?: { origin?: { inputCurrency?: { amountUsd?: unknown } } }
        }
        metadata?: { currencyIn?: { amountUsd?: unknown } }
        currencyIn?: { amountUsd?: unknown }
      }
    | null
    | undefined
  const first = [
    d?.route?.actual?.origin?.inputCurrency?.amountUsd,
    d?.route?.quoted?.origin?.inputCurrency?.amountUsd,
    d?.metadata?.currencyIn?.amountUsd, // v2
    d?.currencyIn?.amountUsd, // v2, never observed live
  ].find((v) => typeof v === "string" || typeof v === "number")
  return first == null ? undefined : String(first)
}

/**
 * Parse a /requests/v3 body. The array is still under a top-level `requests`
 * key, and `status` / `createdAt` are still at the item root — only the amount
 * moved. Anything unreadable yields [] rather than throwing: this feeds a status
 * list, and a parse error must not take the deposit dialog down with it.
 */
export function parseDepositActivity(body: unknown): DepositActivity[] {
  const reqs = (body as { requests?: unknown } | null | undefined)?.requests
  if (!Array.isArray(reqs)) return []
  return reqs.map((r) => {
    const row = (r ?? {}) as { status?: unknown; createdAt?: unknown; data?: unknown }
    return {
      status: typeof row.status === "string" ? row.status : "pending",
      amountUsd: activityAmountUsd(row.data),
      createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
    }
  })
}
