import { TelegramLogo } from "@/components/TelegramLogo";
import { MarketsBrowser } from "@/components/MarketsBrowser";
import { cachedAllMids, cachedOutcomeMeta } from "@/lib/hl-cached";
import { cachedSlabArt } from "@/lib/gacha-server/slab-art";
import { WC_SEED } from "@/lib/wc-results-seed";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function HomePage() {
  const [meta, mids] = await Promise.all([
    cachedOutcomeMeta(),
    cachedAllMids(),
  ]);
  // Tournament finished — results are frozen in the seed, no runtime scan.
  // The old scan re-ran on every new market id and cost seconds of TTFB.
  return (
    <>
      <PacksTeaser />
      <MarketsBrowser meta={meta} initialMids={mids} wcResults={WC_SEED} />
    </>
  );
}

/** Slab art for a cold/absent snapshot cache — the state production is in
 *  until something exercises the gacha proxy there. Top-value cards off a real
 *  catalog snapshot, two each of Pokemon / One Piece / sports per column so no
 *  column reads as one franchise (the columns take every 3rd entry). Public
 *  CloudFront URLs, no key involved. */
const SEED_ART = [
  "fIKHj2OXPEi4ou5NykJO2m6UOKy9snO-29Bv98c-wxg", // Shining Charizard
  "7xJ9QoF2DuWEphysQxMXT2B8JcxoQXcr4VnkdJeBDHY", // Zoro
  "XLcajO_oDeYTWWG1z9huhEgPTHf7CBDnzi5zmkO-WqM", // Haaland
  "6YUADN2mBg8s7Y1U6r08XuGWFCTu8exGUycu-JUZ5eA", // Nami
  "0VtIJgGhWgzivDAoGlq77EavntkuyNAmtOPk8l6QzkQ", // Charizard holo
  "oYrzYWw_HGNEeNpaP7-v1eF58VjJIa_KvYVfHxpzFMk", // Wembanyama
  "UfT5FnjA27nCRWi81oN6jP-DoWAg30LmoCX9dgTweFc", // Brady
  "vxXD-B_fAqtcm3FYRDhPzkSefTdmjs58q69L09IgN00", // Shining Mewtwo
  "kBZZRHnVj6sE_-FcB2QSaoCivY0M7ZajfdWuT-jWuyY", // Luffy
  "QAq_q6MM0LD3z2bZ_hyI8wQXuSJ83qvlY_79mGJoig4", // Gengar
  "He_qxN5DE-ZBRTu2uvn3W5zSUNWaFTL4WJ3x7CQr-cU", // Ohtani
  "z6mL2EJ4rmLcNDRnvgwvuXn9Bg5IFceX2atyXym3LPs", // Kaido
  "5srROrF2L71O-Oxr7ZtxTMi_Rwoyvx0g9GIs0WsDTxk", // Chopper
  "4hx8Z1Okm3WL_KaycuVFX82rxNsrD83d6LJRebtq_II", // Messi
  "f1JHHZt1_TnnuBAThKth4yBxZjkfESVuWkhb7kNJD-Y", // Lillie
  "5G3p1QBTM2Hsk7xxK33CrMtl6ny624ElbbZIQ2civz8", // LeBron
  "1lITnLKvBMGT0kK7rVC1z1jvjokBNor1B_anbAoOpZI", // Luffy (Romance Dawn)
  "P6BXHo2Xg85-seA29oSzMrGneF9B0StF6LqWFpRuXKk", // Flareon Gold Star
].map((k) => `https://d1xpxki1g4htqu.cloudfront.net/${k}`);

/** Teaser for the gacha packs feature landing soon (built on the staging
 *  branch). Slab art marquees in from the cached Slabz catalog, falling back
 *  to SEED_ART so the strip is never empty.
 *  ponytail: delete the whole thing when packs ship. */
async function PacksTeaser() {
  const art = await cachedSlabArt(18);
  // 3 columns, round-robin so each is a different mix; each column repeats its
  // own list twice — that's what makes translateY(-50%) loop seamlessly.
  const src = art.length >= 9 ? art : SEED_ART;
  const cols = [0, 1, 2].map((i) => src.filter((_, j) => j % 3 === i));
  return (
    <section className="rim-brand relative mb-6 overflow-hidden rounded-4xl bg-surface px-5 py-4 pr-[38%] sm:min-h-[13rem] sm:px-6">
      {/* Tailwind's own edge masks (mask-l/mask-y, v4.1+) — they compose into
          one intersected mask, so no hand-rolled mask-image. They sit on a
          wrapper pinned to the section rather than on the art itself: the
          marquee is over-extended past the top and bottom so the tilt leaves no
          bare corner, and a fade measured on that box would land outside the
          section. overflow-hidden because mask-repeat defaults to repeat. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden mask-l-from-25% mask-l-to-45% mask-y-from-80%">
        {/* Rotating the grid slants the columns and their travel with it (the
            tracks translateY inside the rotated frame). Mobile stays upright —
            a tilt in a 38%-wide strip just reads as skew. items-start matters:
            a stretched flex item would size each track to the section, and
            translateY(-50%) has to be half its *content*. */}
        <div className="absolute -inset-y-24 right-0 flex w-[38%] items-start justify-end gap-2 sm:w-[46%] sm:rotate-[10deg] sm:gap-3">
          {cols.map((col, i) => (
            <div
              key={i}
              className="slab-track w-[4.5rem] shrink-0 lg:w-24"
              style={{
                animationDuration: `${54 + i * 14}s`,
                animationDirection: i % 2 ? "reverse" : "normal",
              }}
            >
              {[...col, ...col].map((url, j) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={j}
                  src={url}
                  alt=""
                  className="mb-3 aspect-[5/8] w-full rounded-md border border-brand/25 bg-surface-2 object-cover shadow-lg"
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="relative">
        <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-brand">
          Coming soon
        </span>
        <h2 className="led-glow mt-2 font-heading text-5xl sm:text-6xl">Packs</h2>
      </div>
      <p className="relative mt-2 max-w-lg text-sm text-muted-foreground sm:text-base">
        Rip packs, pull graded slabs, sell back instantly — landing on
        Speculate soon.
      </p>
      <a
        href="https://t.me/+UMKzaeUVv7VjOTk1"
        target="_blank"
        rel="noreferrer noopener"
        className="btn-brand relative mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold"
      >
        <TelegramLogo className="size-4" />
        Join the Telegram for early access
      </a>
    </section>
  );
}
