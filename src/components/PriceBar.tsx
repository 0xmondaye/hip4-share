interface PriceBarProps {
  yesProb: number | null;
  yesLabel: string;
  noLabel: string;
}

export function PriceBar({ yesProb, yesLabel, noLabel }: PriceBarProps) {
  const yesPct =
    yesProb !== null && Number.isFinite(yesProb)
      ? Math.max(0, Math.min(100, yesProb * 100))
      : null;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-xs mb-1.5">
        <span className="font-mono text-yes">
          {yesPct !== null ? `${yesPct.toFixed(1)}%` : "—"}{" "}
          <span className="text-muted-foreground">{yesLabel}</span>
        </span>
        <span className="font-mono text-no">
          <span className="text-muted-foreground">{noLabel}</span>{" "}
          {yesPct !== null ? `${(100 - yesPct).toFixed(1)}%` : "—"}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden flex">
        <div
          className="h-full bg-yes/80 transition-[width] duration-500"
          style={{ width: `${yesPct ?? 0}%` }}
        />
        <div
          className="h-full bg-no/70 transition-[width] duration-500"
          style={{ width: `${yesPct !== null ? 100 - yesPct : 0}%` }}
        />
      </div>
    </div>
  );
}
