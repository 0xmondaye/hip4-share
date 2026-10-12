// Coin mark for an underlying. Marks come from thesvg.org (CC0) via jsDelivr;
// HYPE isn't in that set so its mark is inlined. Anything unmapped falls back
// to a letter circle.
const COIN_LOGOS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
}

// dominant brand color of each mark, for chart lines that should match the
// logo; taken by eye from the SVG fills
const LOGO_COLOR: Record<string, string> = {
  BTC: "#f7931a",
  ETH: "#627eea",
  SOL: "#9945ff",
  HYPE: "#97fce4",
  "xyz:CL": "#ffffff",
  "xyz:DRAM": "#f9bd29",
  "xyz:GOLD": "#d69a00",
  "xyz:NBIS": "#e1ff4f",
  "xyz:SILVER": "#adabb8",
  "xyz:SKHX": "#f58025",
  "xyz:SNDK": "#e10600",
  "xyz:SP500": "#d6002a",
  "xyz:SPCX": "#ffffff",
  "xyz:XYZ100": "#f9bd29",
}

export function logoColor(u: string | undefined): string | undefined {
  return u ? LOGO_COLOR[u] : undefined
}

export function CoinLogo({
  u,
  className = "size-10",
}: {
  u: string
  className?: string // sizing only — chrome (rounded-full etc.) is set here
}) {
  if (u === "HYPE")
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 200 200"
        role="img"
        aria-label="HYPE logo"
        className={`${className} shrink-0 rounded-full bg-surface-2 border border-border`}
      >
        <path
          fill="#97fce4"
          d="M175.11589,99.27891c0,49.46366-30.3687,65.33789-46.47302,51.30413-13.11357-11.5031-17.02471-35.88989-36.81018-38.42055-25.07698-2.99085-27.37764,30.36839-43.94216,30.36839-19.3254,0-23.00642-27.83773-23.00642-42.33179,0-14.72405,4.14115-34.73961,20.47565-34.73961,19.09528,0,20.24566,28.75802,44.17226,27.14754,23.69661-1.61047,24.1567-31.51877,39.80103-44.17224,13.57335-11.27313,45.78283.69019,45.78283,50.84413Z"
        />
      </svg>
    )
  // HIP-3 builder perps ("xyz:SP500") — marks vendored from the deployer's
  // set on app.hyperliquid.xyz into public/coins/ (colon → dash)
  if (u.includes(":"))
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/coins/${u.replace(":", "-")}.svg`}
        alt={`${u} logo`}
        loading="lazy"
        className={`${className} shrink-0 rounded-full bg-surface-2 border border-border`}
      />
    )
  const slug = COIN_LOGOS[u]
  if (!slug)
    return (
      <div
        className={`${className} shrink-0 rounded-full bg-surface-2 border border-border flex items-center justify-center font-bold text-sm`}
      >
        {u.slice(0, 1) || "?"}
      </div>
    )
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/${slug}/default.svg`}
      alt={`${u} logo`}
      loading="lazy"
      className={`${className} shrink-0 rounded-full`}
    />
  )
}
