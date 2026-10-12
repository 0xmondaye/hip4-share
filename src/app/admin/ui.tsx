"use client"

// Shared shells for the admin panel's tabs — the panel is a stack of these
// and nothing else.

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
export const money = (cents: number) => usd.format(cents / 100)
export const shortSubject = (s: string) =>
  s.length > 28 ? `${s.slice(0, 14)}…${s.slice(-8)}` : s

/** Section shell. */
export function Panel({
  title,
  hint,
  right,
  children,
}: {
  title: string
  hint?: string
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">{title}</h2>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  )
}

/** One number the overview row is made of. */
export function Stat({
  label,
  value,
  sub,
}: {
  label: string
  value: React.ReactNode
  sub?: string
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-heading text-xl tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  )
}
