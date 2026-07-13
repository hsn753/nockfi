# Perps Agent — what's needed to build execution

The Perps Agent's read layer is live (`get_perps_info` serves real Lighter mark
prices, funding, open interest, and max leverage). Execution is the last missing
piece, and it needs three things that only an account owner can provide.
Everything below happens on Lighter's side; once the env vars exist, the
engineering work here can start and be tested for real.

## 1. Create a Lighter account

- Go to https://app.lighter.xyz and connect a wallet (this account will hold the
  trading margin — consider a dedicated wallet rather than a personal main one).
- Lighter is its own zk-rollup: funds deposited there live on Lighter, not on
  Robinhood Chain.

## 2. Deposit margin

- Deposit a small amount of USDC via Lighter's bridge (from Arbitrum or
  Ethereum mainnet). $20–50 is plenty for building and testing — position tests
  will be tiny, same philosophy as the $2 stock-collateral test loans.

## 3. Create an API key and add env vars

- In Lighter's app: settings → API keys → create a key (this registers an API
  key with your account index on their L2).
- Add to Vercel (Production env):
  - `LIGHTER_ACCOUNT_INDEX` — shown when the key is created
  - `LIGHTER_API_KEY_INDEX` — ditto
  - `LIGHTER_API_PRIVATE_KEY` — the key's private key (never the wallet's!)

## What gets built once those exist

1. Order placement route (server-side signing with the API key — the key never
   touches the browser), market + reduce-only orders first.
2. Preview/confirm cards with the same server-bound-quote pattern as every
   other agent: mark price, size, leverage, est. liquidation price on the card.
3. Vault guardrails on position size; $NOCK gate (already wired — Perps is a
   premium agent).
4. Position monitoring joining the existing loan-risk sweep: funding drift and
   liquidation distance surfacing in Needs Attention.

## Notes

- The market-data allowlist (crypto/memecoin only, no stock-symbol perps) in
  `lib/get-perps-data.ts` stays — it exists because Lighter lists tokenized
  stock/index perps that overlap confusingly with the Stock Token Agent.
- Until this is built, Robin keeps refusing perps execution honestly (hard
  server-side block in the robin route, not just a prompt rule).
