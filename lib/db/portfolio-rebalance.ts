import { eq, desc } from 'drizzle-orm'
import { getDb } from './client'
import { portfolioRebalanceSettings, portfolioRebalanceEvents, wallets } from './schema'
import { upsertWallet } from './wallets'

export type RebalanceTarget = { symbol: string; address: string; decimals: number; targetPct: number }

export type RebalanceSettingsRow = {
  walletId: string
  enabled: boolean
  driftThresholdPct: string
  targets: RebalanceTarget[]
  lastCheckedAt: Date | null
}

export async function setRebalanceTarget(walletAddress: string, targets: RebalanceTarget[], driftThresholdPct = 5): Promise<void> {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  await db
    .insert(portfolioRebalanceSettings)
    .values({ walletId: wallet.id, enabled: true, targets, driftThresholdPct: String(driftThresholdPct) })
    .onConflictDoUpdate({
      target: portfolioRebalanceSettings.walletId,
      set: { enabled: true, targets, driftThresholdPct: String(driftThresholdPct), updatedAt: new Date() },
    })
}

export async function disableRebalance(walletId: string): Promise<void> {
  const db = getDb()
  await db.update(portfolioRebalanceSettings).set({ enabled: false, updatedAt: new Date() }).where(eq(portfolioRebalanceSettings.walletId, walletId))
}

export async function disableRebalanceByAddress(walletAddress: string): Promise<void> {
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  await disableRebalance(wallet.id)
}

export async function getRebalanceSettings(walletAddress: string): Promise<RebalanceSettingsRow | null> {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  const [row] = await db.select().from(portfolioRebalanceSettings).where(eq(portfolioRebalanceSettings.walletId, wallet.id)).limit(1)
  if (!row) return null
  return { walletId: row.walletId, enabled: row.enabled, driftThresholdPct: row.driftThresholdPct, targets: row.targets as RebalanceTarget[], lastCheckedAt: row.lastCheckedAt }
}

export async function getEnabledRebalanceWallets(): Promise<{ walletId: string; address: string; driftThresholdPct: string; targets: RebalanceTarget[] }[]> {
  const db = getDb()
  const rows = await db
    .select({ walletId: portfolioRebalanceSettings.walletId, address: wallets.address, driftThresholdPct: portfolioRebalanceSettings.driftThresholdPct, targets: portfolioRebalanceSettings.targets })
    .from(portfolioRebalanceSettings)
    .innerJoin(wallets, eq(wallets.id, portfolioRebalanceSettings.walletId))
    .where(eq(portfolioRebalanceSettings.enabled, true))
  return rows.map((r) => ({ ...r, targets: r.targets as RebalanceTarget[] }))
}

export async function touchRebalanceCheckedAt(walletId: string): Promise<void> {
  const db = getDb()
  await db.update(portfolioRebalanceSettings).set({ lastCheckedAt: new Date() }).where(eq(portfolioRebalanceSettings.walletId, walletId))
}

export async function recordRebalanceEvent(input: {
  walletId: string
  fromSymbol: string
  toSymbol: string
  usdAmount?: number
  status: 'executed' | 'not_authorized' | 'failed' | 'skipped'
  errorMessage?: string
}): Promise<void> {
  const db = getDb()
  await db.insert(portfolioRebalanceEvents).values({
    walletId: input.walletId,
    fromSymbol: input.fromSymbol,
    toSymbol: input.toSymbol,
    usdAmount: input.usdAmount != null ? String(input.usdAmount) : undefined,
    status: input.status,
    errorMessage: input.errorMessage,
  })
}

export async function getRecentRebalanceEvents(walletAddress: string, limit = 20) {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  return db.select().from(portfolioRebalanceEvents).where(eq(portfolioRebalanceEvents.walletId, wallet.id)).orderBy(desc(portfolioRebalanceEvents.createdAt)).limit(limit)
}
