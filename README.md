# hip4-frontend

Polymarket-style prediction markets UI for Hyperliquid HIP-4 outcome
contracts. Next.js 16 (App Router), Privy auth, `@nktkas/hyperliquid` SDK.

## Local dev

```bash
bun install
cp .env.local.example .env.local   # add Privy app id
bun dev
```

Required env:

- `NEXT_PUBLIC_PRIVY_APP_ID`

Checks: `bun run typecheck` · `bun run test` · `bun run build`

## Sibling repos

- [`GambitApp/poker-frontend`](https://github.com/GambitApp/poker-frontend) — poker UI, same domain.

## Deploy

Vercel project on the GamBit team. Custom domain to be assigned once
`staging.gambitapp.io` is repointed from the legacy betbit deployment.
