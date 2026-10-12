import { Portfolio } from "@/components/Portfolio";
import { cachedOutcomeMeta } from "@/lib/hl-cached";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  // market metadata lets the client label positions with real market names
  const meta = await cachedOutcomeMeta().catch(() => null);
  return <Portfolio meta={meta} />;
}
