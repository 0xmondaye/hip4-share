# About this copy

A **share-safe snapshot** of the Speculate HIP-4 frontend, published as a single
commit with **no git history** — so nothing can be recovered from earlier commits.

## What was removed or changed

| Item | Why |
|---|---|
| `HANDOFF.md` (755 lines) | Internal ops notes: incident post-mortems, key-management design, credential-rotation status, unvalidated assumptions. |
| `docs/SPEC-gacha-direct.md`, `docs/gacha-flow.md` | Internal specs describing pack economics, markup and vendor terms. |
| `docs/superpowers/` | Internal implementation plans and design specs. |
| Admin allowlist in `src/lib/admin-auth.ts` | Real admin email addresses replaced with `admin{1,2,3}@example.com`. The originals name the accounts that grant production admin access. |
| Full git history | Squashed to one commit so none of the above is reachable via `git log`. |

## What is intentionally kept

- The complete application source, components and API routes.
- `.env.local.example` — documents the configuration surface. It contains **no
  secret values**, only variable names and commentary.
- `docs/PACK-ART-PROMPTS.md` — asset-generation prompts, not sensitive.

## Running it

See `README.md`. You will need your own credentials for every external service
(Privy, Relay, Slabz, Coinflow, Crossmint, Daimo, Neon). None are included here,
and none are recoverable from this repository.

## Note for reviewers

Admin surfaces will not authorise anyone in this copy — the allowlist is
placeholders and `GACHA_GIFT_ADMIN_KEY` is unset, so `/admin` fails closed
with a 503 by design.
