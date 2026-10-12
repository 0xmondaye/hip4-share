/* transitions-dev number pop-in: each char is keyed on its own value, so
   only the chars that actually changed remount and replay — a clock ticking
   45 → 44 pops the 4, not the whole pair. Last two chars ride the stagger. */
export function PopDigits({ value }: { value: string | number }) {
  const chars = String(value).split("")
  return (
    <span className="t-digit-group is-animating">
      {chars.map((ch, i) => (
        <span
          key={`${i}-${ch}`}
          className="t-digit"
          data-stagger={
            i === chars.length - 2
              ? "1"
              : i === chars.length - 1
                ? "2"
                : undefined
          }
        >
          {ch}
        </span>
      ))}
    </span>
  )
}
