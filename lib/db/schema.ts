import { pgTable, text, timestamp, integer, jsonb, uuid, uniqueIndex, index, numeric } from 'drizzle-orm/pg-core'

// Every table anchors on wallet_address (lowercased) — that's the identity every
// existing code path (nock-app.tsx, app/api/robin/route.ts, app/api/activity/route.ts)
// already keys off. privy_user_id is stored alongside it for the auth check
// (lib/auth-server.ts), not as the primary key, since wallet address is what the rest
// of the app already treats as a user's identity.
export const wallets = pgTable('wallets', {
  id: uuid('id').defaultRandom().primaryKey(),
  address: text('address').notNull(),
  privyUserId: text('privy_user_id'),
  walletKind: text('wallet_kind').notNull(), // 'external' | 'embedded'
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('wallets_address_idx').on(t.address),
])

export const conversations = pgTable('conversations', {
  // Matches the client-generated StoredConversation.id from lib/chat-storage.ts —
  // not auto-generated server-side, so the client's existing id scheme keeps working.
  id: text('id').primaryKey(),
  walletId: uuid('wallet_id').notNull().references(() => wallets.id),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('conversations_wallet_idx').on(t.walletId),
])

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'robin'
  text: text('text').notNull(),
  actionJson: jsonb('action_json'), // ActionPreview, when role='robin' and an action was attached
  bridgeInfoJson: jsonb('bridge_info_json'), // BridgeInfo, when present
  seq: integer('seq').notNull(), // ordering within conversation (matches client message array order)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('messages_conversation_seq_idx').on(t.conversationId, t.seq),
])

// The audit-trail core. broadcastStatus (what the client/delegated execution call
// itself reported) and verifyStatus (what /api/verify-tx's independent RPC check
// found) are kept as two separate columns deliberately — we hit two
// confirmed bugs where those disagreed (a claimed success and a claimed revert, both
// for transactions that never actually existed on-chain). Collapsing them into one
// status column would erase exactly the discrepancy that mattered for diagnosing it.
export const transactions = pgTable('transactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  txHash: text('tx_hash'), // nullable — NULL means attempted but never got a hash at all
  chainId: integer('chain_id').notNull().default(4663),
  walletId: uuid('wallet_id').notNull().references(() => wallets.id), // the wallet whose funds moved
  signerAddress: text('signer_address').notNull(), // who actually signed — may differ from walletId's address
  signerType: text('signer_type').notNull(), // 'external' | 'delegated'
  privyWalletId: text('privy_wallet_id'), // set only when signerType='delegated'
  agent: text('agent').notNull(), // AgentId: 'swap' | 'yield' | 'perps' | 'vault'
  actionId: text('action_id'), // ActionPreview.id — links back to the chat message that spawned this tx
  fromTokenSymbol: text('from_token_symbol'),
  fromTokenAddress: text('from_token_address'),
  fromAmount: text('from_amount'), // stored as string, matches existing display formatting, avoids float precision issues
  toTokenSymbol: text('to_token_symbol'),
  toTokenAddress: text('to_token_address'),
  toAmount: text('to_amount'),
  quoteJson: jsonb('quote_json'), // the full raw swap-quote response (txData, price, sources) — complete forensic record
  broadcastStatus: text('broadcast_status').notNull(), // 'submitted' | 'no_hash_returned' | 'client_error'
  verifyStatus: text('verify_status'), // 'success' | 'reverted' | 'not_found' | NULL (not yet verified)
  verifyBlockNumber: text('verify_block_number'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('transactions_wallet_created_idx').on(t.walletId, t.createdAt),
  uniqueIndex('transactions_tx_hash_idx').on(t.txHash),
])

// Recorded opportunistically every time get_yield_options is called (see
// lib/db/vault-snapshots.ts) — no separate cron needed, real usage builds the history
// this needs. totalAssets/totalSupply stored as numeric (not integer/text) since they're
// raw on-chain uint256-scale values that need precise arithmetic for share-price growth
// calculations, not just display. APY is deliberately never stored directly here — it's
// always derived fresh from these snapshots, so there's one source of truth for how it's
// computed rather than a cached number that can drift from the real history.
export const vaultSnapshots = pgTable('vault_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  vaultAddress: text('vault_address').notNull(),
  totalAssets: numeric('total_assets').notNull(),
  totalSupply: numeric('total_supply').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('vault_snapshots_address_recorded_idx').on(t.vaultAddress, t.recordedAt),
])

// The real, user-configurable half of Vault Agent's spend limit — an additional,
// app-level ceiling checked in propose_action (app/api/robin/route.ts) before any
// swap/yield action is ever proposed. This sits alongside, not instead of, the
// hardcoded global 0.05 ETH Privy policy (app/api/admin/setup-session-policy/route.ts)
// that already gates delegated execution server-side — that stays as the outer ceiling
// for delegated swaps; this can only ever be a tighter, user-set restriction on top,
// and is the first limit of any kind for external-wallet execution. One row per wallet;
// no row (or a null limit) means unlimited — never a fabricated default.
export const walletGuardrails = pgTable('wallet_guardrails', {
  id: uuid('id').defaultRandom().primaryKey(),
  walletId: uuid('wallet_id').notNull().references(() => wallets.id),
  maxUsdPerTransaction: numeric('max_usd_per_transaction'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('wallet_guardrails_wallet_idx').on(t.walletId),
])

// Written by the loan-monitoring sweep (app/api/cron/monitor-loans) when an open
// stock-collateral loan crosses the risk threshold, resolved when it comes back
// under (or closes). Persisted so the warning survives to the user's next visit
// with the real timestamp — "your loan hit 84% at 3:40 AM" — instead of only
// existing while the app happens to be open. One OPEN row per wallet+symbol at
// a time; resolved rows stay as history.
export const loanRiskEvents = pgTable('loan_risk_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  walletId: uuid('wallet_id').notNull().references(() => wallets.id),
  stockSymbol: text('stock_symbol').notNull(),
  ltvUtilizationPct: numeric('ltv_utilization_pct').notNull(),
  liquidationPriceUsd: numeric('liquidation_price_usd'),
  oraclePriceUsd: numeric('oracle_price_usd'),
  debtUsd: numeric('debt_usd').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [
  index('loan_risk_events_wallet_idx').on(t.walletId, t.createdAt),
])

// Append-only — durable even if Privy's own dashboard-side policy/signer registration
// later changes. Records every instant-swap wallet lifecycle event.
export const delegatedWalletEvents = pgTable('delegated_wallet_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  walletId: uuid('wallet_id').notNull().references(() => wallets.id), // the OWNER (connected/external) wallet
  embeddedAddress: text('embedded_address').notNull(),
  privyWalletId: text('privy_wallet_id').notNull(),
  signerId: text('signer_id').notNull(),
  policyId: text('policy_id').notNull(),
  eventType: text('event_type').notNull(), // 'created' | 'enabled' | 'disabled' | 'export_initiated'
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('delegated_wallet_events_wallet_idx').on(t.walletId, t.occurredAt),
])
