import { flagCode } from "@/lib/flags";

// ponytail: plain <img> from flagcdn.com — next/image remote config not worth
// it for ~1KB PNGs. Default size is inline-text height; pass className for bigger.
export function FlagImg({
  name,
  className = "h-4 rounded-[3px]",
}: {
  name: string | undefined;
  className?: string;
}) {
  const code = name ? flagCode(name) : null;
  if (!code) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://flagcdn.com/w80/${code}.png`}
      srcSet={`https://flagcdn.com/w160/${code}.png 2x`}
      alt={`${name} flag`}
      loading="lazy"
      className={`inline-block w-auto object-cover align-[-0.15em] ${className}`}
    />
  );
}
