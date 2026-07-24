import { eq, desc } from 'drizzle-orm'
import { getDb } from './client'
import { yieldAutomationSettings, yieldAutomationEvents, wallets } from './schema'
import { upsertWallet } from './wallets'

export type YieldAutomationSettingsRow = {
  walletId: string
  enabled: boolean
  minApyDeltaPct: string
  authorizedAt: Date | null
  authTxHash: string | null
  lastCheckedAt: Date | null
}

// Called after independently verifying isAuthorized on-chain — never on a client's claim
// alone. authTxHash is the setAuthorization tx the user just signed, kept for audit.
export async function enableYieldAutomation(walletAddress: string, authTxHash: string): Promise<void> {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  await db
    .insert(yieldAutomationSettings)
    .values({ walletId: wallet.id, enabled: true, authorizedAt: new Date(), authTxHash })
    .onConflictDoUpdate({
      target: yieldAutomationSettings.walletId,
      set: { enabled: true, authorizedAt: new Date(), authTxHash, updatedAt: new Date() },
    })
}

// Used both for a user's own explicit disable AND the cron sweep's defensive auto-disable
// when it finds on-chain authorization was revoked outside the app.
export async function disableYieldAutomation(walletId: string): Promise<void> {
  const db = getDb()
  await db
    .update(yieldAutomationSettings)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(yieldAutomationSettings.walletId, walletId))
}

export async function disableYieldAutomationByAddress(walletAddress: string): Promise<void> {
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  await disableYieldAutomation(wallet.id)
}

export async function getYieldAutomationSettings(walletAddress: string): Promise<YieldAutomationSettingsRow | null> {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  const [row] = await db
    .select()
    .from(yieldAutomationSettings)
    .where(eq(yieldAutomationSettings.walletId, wallet.id))
    .limit(1)
  if (!row) return null
  return {
    walletId: row.walletId,
    enabled: row.enabled,
    minApyDeltaPct: row.minApyDeltaPct,
    authorizedAt: row.authorizedAt,
    authTxHash: row.authTxHash,
    lastCheckedAt: row.lastCheckedAt,
  }
}

// Every wallet currently opted in, joined to its address for the cron sweep to act on.
export async function getEnabledYieldAutomationWallets(): Promise<{ walletId: string; address: string; minApyDeltaPct: string }[]> {
  const db = getDb()
  const rows = await db
    .select({ walletId: yieldAutomationSettings.walletId, address: wallets.address, minApyDeltaPct: yieldAutomationSettings.minApyDeltaPct })
    .from(yieldAutomationSettings)
    .innerJoin(wallets, eq(wallets.id, yieldAutomationSettings.walletId))
    .where(eq(yieldAutomationSettings.enabled, true))
  return rows
}

export async function touchYieldAutomationCheckedAt(walletId: string): Promise<void> {
  const db = getDb()
  await db.update(yieldAutomationSettings).set({ lastCheckedAt: new Date() }).where(eq(yieldAutomationSettings.walletId, walletId))
}

export type RecordYieldAutomationEventInput = {
  walletId: string
  fromMarket: string | null
  toMarket: string
  amountUsdg: string
  fromApyPct: number | null
  toApyPct: number
  withdrawTxHash?: string
  supplyTxHash?: string
  status: 'success' | 'failed'
  errorMessage?: string
}

export async function recordYieldAutomationEvent(input: RecordYieldAutomationEventInput): Promise<void> {
  const db = getDb()
  await db.insert(yieldAutomationEvents).values({
    walletId: input.walletId,
    fromMarket: input.fromMarket,
    toMarket: input.toMarket,
    amountUsdg: input.amountUsdg,
    fromApyPct: input.fromApyPct !== null ? String(input.fromApyPct) : null,
    toApyPct: String(input.toApyPct),
    withdrawTxHash: input.withdrawTxHash,
    supplyTxHash: input.supplyTxHash,
    status: input.status,
    errorMessage: input.errorMessage,
  })
}

export async function getRecentYieldAutomationEvents(walletAddress: string, limit = 20) {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  return db
    .select()
    .from(yieldAutomationEvents)
    .where(eq(yieldAutomationEvents.walletId, wallet.id))
    .orderBy(desc(yieldAutomationEvents.createdAt))
    .limit(limit)
}
