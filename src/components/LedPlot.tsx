// LED dot-matrix plot body: area fade + line + proximity glow, all punched
// through a dot grid. Shared by the portfolio PnL chart and the live
// price/chance charts so they read as the same chart.
//
// LED grid: PITCH = cell size, DOT = dot diameter, HALO = px reach of the
// near-line falloff on the unlit dots, GLOW = its peak opacity.
export const PITCH = 2.618 // DOT + 1px gap
const DOT = 1.618
const HALO = 22
const GLOW = 0.16

export function LedPlot({
  id,
  d,
  w,
  h,
  base,
  color = "var(--brand)",
  area = true,
}: {
  id: string // unique per instance: every def below is namespaced with it
  d: string // line path, left edge to right
  w: number // plot width (excludes any axis gutter)
  h: number // full svg height
  base: number // plot floor the area fill closes to
  color?: string
  area?: boolean // off for multi-series charts: stacked fades just go muddy
}) {
  return (
    <>
      <defs>
        <pattern id={`${id}-led`} width={PITCH} height={PITCH} patternUnits="userSpaceOnUse">
          <circle cx={PITCH / 2} cy={PITCH / 2} r={DOT / 2} fill="#fff" />
        </pattern>
        <mask id={`${id}-led-mask`}>
          <rect width={w} height={h} fill={`url(#${id}-led)`} />
        </mask>
        <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
        {/* proximity falloff: fat blurred copy of the line, used as the alpha
            for the unlit dot field. Explicit regions on both — the default
            -10%/120% bbox region clips a blur this wide. */}
        <filter id={`${id}-blur`} x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur stdDeviation={HALO * 0.6} />
        </filter>
        <mask
          id={`${id}-halo-mask`}
          maskUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={w}
          height={h}
        >
          <path
            d={d}
            fill="none"
            stroke="#fff"
            strokeWidth={HALO}
            strokeLinecap="round"
            filter={`url(#${id}-blur)`}
          />
        </mask>
      </defs>
      {/* ponytail: dot mask over a PITCH-wide stroke, no per-column
          quantisation — the mask grid supplies the stair-steps. Quantise y
          per column only if the steps need to line up exactly. */}
      <g mask={`url(#${id}-led-mask)`}>
        <rect
          width={w}
          height={h}
          fill={color}
          opacity={GLOW}
          mask={`url(#${id}-halo-mask)`}
        />
        {area && (
          <path d={`${d}L${w},${base}L0,${base}Z`} fill={`url(#${id}-fade)`} />
        )}
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={PITCH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </>
  )
}
