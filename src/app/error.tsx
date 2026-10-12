"use client"

// Branded fallback for server render failures (usually an upstream
// Hyperliquid rate limit) — replaces the raw platform error page.
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface/50 p-10 sm:p-14 text-center space-y-3">
      <div className="text-2xl">📡</div>
      <h1 className="text-xl font-semibold">Markets are busy right now</h1>
      <p className="text-sm text-muted-foreground">
        We couldn&apos;t reach the exchange — your funds are unaffected. Give
        it a second and try again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="btn-brand inline-flex items-center h-10 px-5 text-sm font-semibold cursor-pointer"
      >
        Try again
      </button>
    </div>
  )
}
