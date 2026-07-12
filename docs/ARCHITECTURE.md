# Nock — Architecture & Operations Reference

Last updated: July 2026. This is the recovery document: everything needed to understand,
debug, or rebuild any part of the system, including facts that were verified on-chain
and would be expensive to rediscover.

---

## 1. Core design principles

1. **Preview, then confirm.** Robin (the AI) can only *propose* actions. The one and only
   execution path is the user pressing **Confirm** on an action card in the client
   (`handleLoose` in `components/nock/nock-app.tsx`). The server never signs or sends
   anything on its own initiative.
2. **Never trust the model with money.** Every financially consequential behavior has a
   hard, code-level guard — prompt instructions alone failed repeatedly in production.
   The full list of guards is in section 6.
3. **Never invent data.** All prices, APYs, balances, and positions come from live RPC
   reads or live quotes at answer time. When data isn't available, the app says so
   plainly instead of estimating.
4. **Independent verification.** A transaction is only reported successful after
   `/api/verify-tx` independently confirms the receipt via our own RPC — never on the
   strength of what a wallet or execution call claimed. Wallet clients produced both
   false successes and false reverts in production.

## 2. Chain & contract addresses (all verified on-chain, not from docs)

| Thing | Address / value |
|---|---|
| Robinhood Chain | Arbitrum Orbit L2, chain id **4663**, RPC `https://rpc.mainnet.chain.robinhood.com`, explorer `https://robinhoodchain.blockscout.com` |
| USDG (6 decimals) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| 0x AllowanceHolder router | `0x0000000000001fF3684f28c67538d4D072C22734` |
| Morpho Blue core | `0x9d53d5e3bd5e8d4cbfa6db1ca238aea02e651010` (verified source; `supply()` has no access control) |
| Steakhouse USDG vault (Robinhood Earn) | `0xBeEff033F34C046626B8D0A041844C5d1A5409dd` — ERC4626, **closed**: `maxDeposit()` returns 0 for every address |
| Vault's adapter (how we found Morpho core) | `MorphoMarketV1AdapterV2` at `0x44abc1d6ccff2696d98890b92e2157af242179c2` |
| Morpho IRM (all three markets) | `0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1` (`borrowRateView` selector `0x8c00bf6b`) |

### Morpho markets we lend into (the same three the Robinhood Earn vault uses)

All lend USDG; lltv `915000000000000000` (91.5%) for all three. Params are immutable
once a market is created, so hardcoding them in `lib/get-morpho-markets.ts` is safe.

| Market | Id | Collateral | Oracle |
|---|---|---|---|
| USDe (Ethena) | `0xc845da65a020ddca5f132efa8fea79676d8edfdea504226a4c01e7a9e34cddd6` | `0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34` | `0xe64849bd4ad03dfabbe02bb521de19997a19055f` |
| syrupUSDG (Maple) | `0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7` | `0x40858070814a57fdf33a613ae84fe0a8b4a874f7` | `0x152c638fad68913739ee19ba8ef47faeb09dca91` |
| spUSDG (Spark) | `0x0309c02dabf0be02682af1a2bde9a457f4df0f0b6bc889cde3f948e5315e4114` | `0xde770c84fe66e063336b31737cfe9790f18c4087` | `0xe694c531f65c4babc88a52d7178476e095e51574` |

Supply APY is computed live: `borrowRateView × utilization × (1 − fee)`, compounded.
There is no snapshot/caching — every display is a fresh read.

## 3. Request flow

```
user message
  → client handleSend (nock-app.tsx)
      - typed "confirm"/"loose" executes the latest actionable card directly
      - bare affirmatives ("yes proceed") get a deterministic local answer
  → POST /api/robin (identity token header)
      - auth: requireAuthenticatedWallet (lib/auth-server.ts) when a wallet is claimed
      - OpenAI tool loop (max 6 rounds) over the tools in section 4
      - deterministic command path: "lend/withdraw X USDG from/to <market>" builds the
        quote directly if the model failed to
      - card synthesis: a successful yield quote with no card gets one built server-side
      - response guards: text claiming an execution or a nonexistent card is replaced
  → client renders reply + optional action card
user presses Confirm (or types "confirm")
  → handleLoose: pre-flight checks → execution → audit log → independent verify → UI
```

Execution branches inside `handleLoose`:
- **External wallet**: fresh provider via Privy (`getEthereumProvider()` — cached wagmi
  clients go stale when the user switches networks in the wallet UI), then
  `lib/execute-swap.ts` (`approve` if needed → send → wait receipt).
- **Delegated (instant-swap) wallet**: only when the *connected* wallet is itself the
  delegated one. Routes through `/api/execute-delegated-swap` →
  `lib/privy-server.ts:executeDelegatedTransaction` (Privy session signer). The Privy
  policy (section 7) only allows the 0x router, so yield lending on a delegated wallet
  is declined client-side with an honest message.
- **Yield withdrawals**: skip the sell-token balance/approval pre-flight (funds flow
  *into* the wallet); gas check only; approval skipped by passing amount `'0'`.

After any execution attempt, in order:
1. `POST /api/transactions/log-submission` (awaited — unawaited, verify-tx's UPDATE can
   race ahead of the INSERT and silently update zero rows)
2. `POST /api/verify-tx` — the only authority on success/revert/not-found
3. UI success/failure message (client posts "Done! … TX: 0x…" — the only message that
   ever legitimately claims an execution happened)

## 4. Robin's tools (app/api/robin/route.ts)

| Tool | Backing |
|---|---|
| `get_wallet_holdings` | live balances, verified token list (`lib/get-balances.ts`) |
| `get_token_balance` | arbitrary ERC-20 balance by address |
| `get_trending_tokens` | DexScreener-backed memecoin lookup (unverified, warned) |
| `get_swap_quote` | 0x API v2, real transaction included (`lib/get-swap-quote.ts`) |
| `get_bridge_info` | canonical Arbitrum bridge link + client-side arrival watcher |
| `get_yield_options` | vault state + the three Morpho markets, live APYs |
| `get_yield_deposit_quote` | Morpho market supply (or the gated vault when no market given) |
| `get_yield_withdraw_quote` | Morpho withdraw, gated by position size and market idle liquidity |
| `get_yield_positions` | live per-market supplied balances (interest included) |
| `get_perps_info` | Lighter public API, crypto/memecoin allowlist only |
| `get_vault_status` | user's spend limit + automatic protections |
| `propose_action` | builds the action card — heavily guarded, see section 6 |

## 5. Database (Vercel Postgres / Neon, Drizzle — lib/db/schema.ts)

- `wallets` — one row per address (lowercased), upserted on every authenticated request.
- `conversations` / `messages` — chat persistence.
- `transactions` — the audit trail. `broadcast_status` (what execution claimed) and
  `verify_status` (what our independent RPC check found) are deliberately separate
  columns; they disagreed in two real production bugs. Withdrawals log with
  `from_token_symbol` = market, `to_token_symbol` = USDG (direction is visible).
- `vault_snapshots` — vault share-price history (opportunistic, for vault APY).
- `wallet_guardrails` — per-wallet USD-per-transaction spend limit; null = unlimited.
- `delegated_wallet_events` — append-only instant-swap wallet lifecycle log.

Schema changes: `npx drizzle-kit push` with `.env.local` sourced (no migration files —
push mode against the live DB).

## 6. Hard guards (all discovered from real production failures)

Server (`app/api/robin/route.ts`):
- **Quote freshness** — `propose_action` for swap/yield only succeeds with a real quote
  fetched in the same request; the model built cards from remembered numbers otherwise.
- **No amount guessing** — swap/yield quote tools refuse unless a user message contains
  a digit (contract addresses stripped first); the model defaulted to "100 USDG".
- **Token mismatch** — if the user's latest message names a token that matches neither
  side of the quote, the proposal is refused (the model once silently substituted USDG
  for the token the user actually asked for).
- **Outcome value recomputed** — the card's dollar value is computed from live prices,
  never the model's arithmetic (raw token quantities were rendered as dollars once).
- **Spend limit (Vault agent)** — proposals above the user's `wallet_guardrails` limit
  are refused before a card is ever produced. Withdrawals exempt: a limit must never
  trap someone's own position.
- **Perps hard block** — `propose_action` for perps always refuses (no execution path).
- **Execution-claim guard** — any response text claiming something "executed
  successfully" is replaced: the server never executes, so such text is false by
  construction. The model produced fake success claims twice in production.
- **Card synthesis** — a successful yield quote with no `propose_action` call gets its
  card built server-side (the model repeatedly failed to chain quote → propose for
  withdrawals, leaving users unable to reach their own funds).
- **Deterministic command path** — "lend/withdraw N USDG to/from <market>" is parsed
  and quoted directly, bypassing the model for the highest-stakes flows.

Client (`components/nock/nock-app.tsx`):
- Typed "confirm"/"loose" executes the newest actionable card; "review"/"draw" opens
  review; bare affirmatives get a fixed local reply. None of these reach the model.
- Pre-flight balance + gas checks with the exact token address/decimals from the quote.
- Chain check with a fresh provider immediately before signing.

## 7. Privy setup (things that are easy to lose)

- **Identity tokens must be enabled** in the Privy Dashboard ("Return user data in an
  identity token", bottom of Authentication → Advanced). Off by default; without it all
  authenticated routes fail with "missing identity token".
- Client code must use the async `getIdentityToken()` getter at each call site — the
  reactive `useIdentityToken()` hook does not reliably hold a usable token.
- Session signer + policy ids are registered in the dashboard and hardcoded in
  `components/nock/settings-view.tsx` (`SESSION_SIGNER_ID`, `SESSION_POLICY_ID`).
- The session policy (created via `app/api/admin/setup-session-policy/route.ts`, gated
  by `ADMIN_SETUP_TOKEN`) allows: transactions to the 0x router up to 0.05 ETH, and
  zero-value `approve()` to the verified swap tokens. It does **not** cover Morpho —
  extending it for delegated yield lending needs care around the withdraw receiver.

## 8. Known blockers (external, verified — not bugs)

- **Robinhood Earn vault closed**: `maxDeposit()` = 0 for every address on all four
  Steakhouse-affiliated vaults. Deposits route through Robinhood's own gated app. Our
  vault-deposit code checks `maxDeposit` live and starts working automatically if this
  ever opens. Direct Morpho market lending is the working alternative (what we ship).
- **Perps execution**: Lighter signs orders with Schnorr signatures over the ECgFp5
  curve (confirmed from their `lighter-go` source) — not something an Ethereum wallet
  can produce. Official SDKs are Python/Go only; community TS SDKs are unaudited.
  Revisit if Lighter ships an official TS SDK (`elliottech/lighter-python` issue #49)
  or publishes deposit-contract docs.
- **Morpho's GraphQL API doesn't index Robinhood Chain** — all Morpho data must come
  from direct RPC reads (which is what we do).

## 9. Operational runbook

- **Deploy**: `git push origin main && npx vercel --prod --yes`
- **Prod logs**: `npx vercel logs https://nock-main.vercel.app --since 30m`
  (every Robin tool call is logged: `[robin] tool call: <name> <args>`)
- **Audit queries**: connect with `POSTGRES_URL` from `.env.local`; the `transactions`
  table is the source of truth for what was attempted vs what actually happened.
- **Verify any tx independently**: `eth_getTransactionReceipt` against
  `https://rpc.mainnet.chain.robinhood.com`, or Blockscout.
- **Check a user's yield position on-chain** (bypassing the whole app):
  `position(marketId, user)` (selector `0x93c52062`) on the Morpho core; assets =
  shares × totalSupplyAssets / totalSupplyShares from `market(id)` (`0x5c60e39a`).
- **Gas errors on yield actions** ("max fee per gas less than block base fee"): quotes
  carry 2× the gas price snapshot for drift headroom; on this chain senders pay the
  actual base fee, not the bid, so the buffer costs nothing.

## 10. Product language

The action buttons are **Review** (inspect the proposal) and **Confirm** (execute).
Earlier builds used the archery-themed Draw/Loose; typed "draw"/"loose" still work as
aliases. Internal identifiers (`onDraw`, `handleLoose`, `status: 'reviewing'`) retain
the old names — renaming them is cosmetic churn with no user-facing benefit.
