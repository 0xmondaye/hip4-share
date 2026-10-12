import type { ReactNode } from "react"

export function StatusPill({
  children,
  tone = "lime",
}: {
  children: ReactNode
  tone?: "lime" | "blue"
}) {
  return (
    <span className={`inline-flex shrink-0 items-center leading-none overflow-hidden px-1 py-px border-t border-t-white/40 rounded-full shadow-md scrim-b-6 ring-1 font-sans text-[9px] font-bold ${
      tone === "blue"
        ? "bg-blue-600 text-white shadow-blue-900/20 scrim-blue-500/30 ring-blue-600 tracking-normal"
        : "bg-lime-400 text-black shadow-lime-900/20 scrim-lime-200/60 ring-lime-600"
    }`}>
      {children}
    </span>
  )
}
