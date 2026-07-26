import { eq, desc } from 'drizzle-orm'
import { getDb } from './client'
import { liquidationProtectionSettings, liquidationProtectionEvents, wallets } from './schema'
import { upsertWallet } from './wallets'

export type LiquidationProtectionSettingsRow = {
  walletId: string
  enabled: boolean
  triggerLtvPct: string
  targetLtvPct: string
  authorizedAt: Date | null
  authTxHash: string | null
  lastCheckedAt: Date | null
}

// Called after independently verifying isAuthorized on-chain — never on a client's claim.
export async function enableLiquidationProtection(walletAddress: string, authTxHash: string | null): Promise<void> {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  await db
    .insert(liquidationProtectionSettings)
    .values({ walletId: wallet.id, enabled: true, authorizedAt: new Date(), authTxHash: authTxHash ?? undefined })
    .onConflictDoUpdate({
      target: liquidationProtectionSettings.walletId,
      set: { enabled: true, authorizedAt: new Date(), authTxHash: authTxHash ?? undefined, updatedAt: new Date() },
    })
}

export async function disableLiquidationProtection(walletId: string): Promise<void> {
  const db = getDb()
  await db
    .update(liquidationProtectionSettings)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(liquidationProtectionSettings.walletId, walletId))
}

export async function disableLiquidationProtectionByAddress(walletAddress: string): Promise<void> {
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  await disableLiquidationProtection(wallet.id)
}

export async function getLiquidationProtectionSettings(walletAddress: string): Promise<LiquidationProtectionSettingsRow | null> {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  const [row] = await db
    .select()
    .from(liquidationProtectionSettings)
    .where(eq(liquidationProtectionSettings.walletId, wallet.id))
    .limit(1)
  if (!row) return null
  return {
    walletId: row.walletId,
    enabled: row.enabled,
    triggerLtvPct: row.triggerLtvPct,
    targetLtvPct: row.targetLtvPct,
    authorizedAt: row.authorizedAt,
    authTxHash: row.authTxHash,
    lastCheckedAt: row.lastCheckedAt,
  }
}

export async function getEnabledLiquidationProtectionWallets(): Promise<
  { walletId: string; address: string; triggerLtvPct: string; targetLtvPct: string }[]
> {
  const db = getDb()
  return db
    .select({
      walletId: liquidationProtectionSettings.walletId,
      address: wallets.address,
      triggerLtvPct: liquidationProtectionSettings.triggerLtvPct,
      targetLtvPct: liquidationProtectionSettings.targetLtvPct,
    })
    .from(liquidationProtectionSettings)
    .innerJoin(wallets, eq(wallets.id, liquidationProtectionSettings.walletId))
    .where(eq(liquidationProtectionSettings.enabled, true))
}

export async function touchLiquidationProtectionCheckedAt(walletId: string): Promise<void> {
  const db = getDb()
  await db
    .update(liquidationProtectionSettings)
    .set({ lastCheckedAt: new Date() })
    .where(eq(liquidationProtectionSettings.walletId, walletId))
}

export type RecordLiquidationProtectionEventInput = {
  walletId: string
  stockSymbol: string
  ltvBeforePct: number
  ltvTargetPct: number
  repaidUsdg?: string
  fundedFromMarket?: string
  withdrawTxHash?: string
  repayTxHash?: string
  status: 'protected' | 'insufficient_funds' | 'failed'
  errorMessage?: string
}

export async function recordLiquidationProtectionEvent(input: RecordLiquidationProtectionEventInput): Promise<void> {
  const db = getDb()
  await db.insert(liquidationProtectionEvents).values({
    walletId: input.walletId,
    stockSymbol: input.stockSymbol,
    ltvBeforePct: String(input.ltvBeforePct),
    ltvTargetPct: String(input.ltvTargetPct),
    repaidUsdg: input.repaidUsdg,
    fundedFromMarket: input.fundedFromMarket,
    withdrawTxHash: input.withdrawTxHash,
    repayTxHash: input.repayTxHash,
    status: input.status,
    errorMessage: input.errorMessage,
  })
}

export async function getRecentLiquidationProtectionEvents(walletAddress: string, limit = 20) {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  return db
    .select()
    .from(liquidationProtectionEvents)
    .where(eq(liquidationProtectionEvents.walletId, wallet.id))
    .orderBy(desc(liquidationProtectionEvents.createdAt))
    .limit(limit)
}
