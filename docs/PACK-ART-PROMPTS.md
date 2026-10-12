# Pack artwork prompts (Nano Banana / Gemini image)

For generating the pack panel art that `scripts/gen-pack-foil.mjs` composites
into the foil atlas.

## How to use the output

1. Generate at **2:3** aspect (closest to the panel's 1188×1854 ≈ 1:1.56).
2. Save as `public/rippack/art/<skin>.png` — `mystery`, `monster`, `pirate`,
   `sports`, or `comic`.
3. `node scripts/gen-pack-foil.mjs`

The script keeps the crimp bands, wordmark, corner labels, brand badge and panel
lighting and lays them over your image. So:

- **Do not ask for text.** The wordmark is overlaid in the real brand font
  (Geist Pixel Circle). Text in the generated image will collide with it, and
  image models spell badly at small sizes.
- **Do not ask for a pack, pouch, wrapper, or mockup.** You are generating the
  *printed panel*, flat. A rendered pack at an angle is unusable as a texture.
- Leave the top ~20% and bottom ~15% dark and quiet — that is where the wordmark
  and the corner labels land.

## The prompt

Paste the block below, with one `HERO` line from the table swapped in.

> A flat, head-on, orthographic printed artwork panel for a trading-card
> product — the print file itself, not a photograph or a mockup of anything.
> Vertical 2:3 composition, artwork bleeding fully to all four edges with no
> border, no frame, no white margin, no rounded corners, and no drop shadow.
>
> Palette is locked to near-black and one acid lime: background ranges from
> `#010200` to `#101c07`, the subject is rendered in `#a3e635` through
> `#f2ffd4` with shadow tones down to `#4c6e12`. No other hue anywhere — no
> teal, no yellow-orange, no purple, no red.
>
> **HERO** — one single subject, centred horizontally, its centre of mass at
> about 45% of the panel height, occupying roughly 55% of the panel width. It
> reads as a solid dimensional object with a glossy foil-stamped surface: a
> bright specular hotspot on its upper-left, a soft dark core shadow wrapping
> its lower-right, a thin bright bevel along its upper-left edge, and a soft
> cast shadow falling down and to the right onto the background. Light comes
> from the upper-left throughout.
>
> Background is a deep black field with a faint lime radial glow behind the
> subject, a scatter of small crisp lime specks, and concentric ring lines at
> very low contrast. The top fifth and the bottom sixth of the panel fall away
> to near-black and stay visually empty.
>
> Sharp and high-contrast, print-clean vector-poster rendering. No text, no
> letters, no numbers, no logos, no watermark, no signature. No blur, no haze,
> no film grain, no bokeh, no lens flare.

| skin      | HERO line                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `mystery` | A single playing-card spade symbol, sharp apex, wide low lobes, flared stem                                                    |
| `monster` | A smooth spherical energy orb with a jagged lightning bolt cut into its face                                                   |
| `pirate`  | A jolly-roger skull above crossed bones, hollow eye sockets, blocky teeth                                                      |
| `sports`  | A triangular pennant flag on a vertical staff, with a stitched ball resting at the staff's base                                |
| `comic`   | A jagged many-pointed comic-book impact burst with a five-pointed star at its centre                                           |

## If a result is unusable

Most failures are one of three things, in order of likelihood:

- **It rendered a pack.** Add: "This is a flat 2D print file. Do not draw a bag,
  pouch, wrapper, packet, envelope, box or any 3D product."
- **It added text.** Add: "Absolutely no text, glyphs or symbols resembling
  letters anywhere in the image."
- **The palette drifted.** Add: "Strictly two colours: black and lime green
  `#a3e635`. Monochrome lime on black."

## Note on the licensed categories

The hero motifs above are deliberately generic. A poké ball, a straw hat, or a
league logo is someone's trademark, and the pack is commercial merchandise —
generating one is a legal problem, not a design choice. The pack's actual name
comes from the Slabz API at runtime, so the art never has to say the franchise.
