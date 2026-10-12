# CLAUDE.md — hip4-frontend

Part of Gambit ([GambitApp](https://github.com/GambitApp)) — split repos
(not a monorepo). See sibling repos linked from README.md.

## Rules

- No credentials in the repo. Ever.
- No .env files committed (see .gitignore).
- Cross-repo boundaries are HTTP + typed messages. Never share DB rows.
- CI must pass before merge (typecheck / forge build + tests + security scans).
