# Nock — agent concierge for Robinhood Chain

Chat-based DeFi concierge. You tell Robin what you want in plain language; it routes the
request to a specialized agent (swap, yield, perps, vault), shows a preview card, and
executes only after you press Confirm. Nothing moves without an explicit confirmation,
and every number shown comes from a live on-chain read or a live quote — never invented.

Production: https://nock-main.vercel.app

## Stack

- Next.js (App Router) + TypeScript, deployed on Vercel
- Privy for wallet auth (external wallets + embedded "instant swap" wallet with session signers)
- wagmi/viem for chain access — Robinhood Chain (Arbitrum Orbit L2, chain id 4663)
- Vercel Postgres (Neon) + Drizzle ORM for the audit trail and user settings
- OpenAI (gpt-4o-mini) for the Robin router — with hard server-side guards around
  everything financially consequential (see docs/ARCHITECTURE.md)
- 0x Swap API for swap quotes/routing; Morpho Blue for lending; Lighter public API for
  perps market data

## Getting started

```bash
pnpm install
npx vercel env pull .env.local   # pulls all required env vars for development
pnpm run dev
```

Required env vars (see .env.example): `OPENAI_API_KEY`, `ZEROX_API_KEY`,
`NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_PRIVATE_KEY`,
`RPC_URL`, `POSTGRES_URL` (plus the rest of the Neon set), `ADMIN_SETUP_TOKEN`.
Never commit real values; `.env.local` is gitignored.

## Deploying

```bash
git push origin main          # source of truth
npx vercel --prod --yes       # deploy to production
```

Database schema changes: edit `lib/db/schema.ts`, then
`set -a && source .env.local && set +a && npx drizzle-kit push`.

## Current agent status

| Agent | Status |
|---|---|
| Swap  | Live — real 0x-routed swaps, executing in production |
| Yield | Live — real USDG lending + withdrawal on Morpho Blue markets, executing in production |
| Perps | Read-only — real live Lighter market data; execution blocked (see docs) |
| Vault | Live — guardrails layer: user-set spend limit enforced server-side on every proposal |

Full architecture, verified contract addresses, safety guards, known blockers, and the
operational runbook live in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
