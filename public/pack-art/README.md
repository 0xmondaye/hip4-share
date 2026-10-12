# House pack prints

Every pack print is ours — nothing textures from Slabz any more.

Drop `<ccPackType>_front.webp` and `<ccPackType>_back.webp` here (e.g.
`pokemon_25_front.webp`) for a per-pack print. A family file —
`pokemon_front.webp` — standardises EVERY `pokemon_*` pack with one artwork;
an exact-type file overrides it per pack.

Lookup order: exact type → family → `pokemon_*` (the house default, which
backstops the whole catalogue until per-family prints land) → the front print
standing in for a missing back.

Specs: full-bleed portrait, 1355×2480, sRGB. The front maps edge-to-edge onto
the pack face — no crimp or margins, the mesh supplies those. The back is
sampled through a UV window authored in the GLB, so a back file has to be laid
out for that window; without one the front print stands in.
