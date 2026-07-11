import { pgTable, text, timestamp, integer, jsonb, uuid, uniqueIndex, index } from 'drizzle-orm/pg-core'

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
// found) are kept as two separate columns deliberately — this session had two
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
