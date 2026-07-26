import { eq, and, desc } from 'drizzle-orm'
import { getDb } from './client'
import { automationConditions, automationConditionEvents, wallets } from './schema'
import { upsertWallet } from './wallets'

export type ConditionRow = typeof automationConditions.$inferSelect

export type CreateConditionInput = {
  walletAddress: string
  kind: 'token_price' | 'loan_ltv'
  symbol: string | null
  tokenAddress: string | null
  comparator: 'below' | 'above'
  threshold: number
  action?: string
}

export async function createCondition(input: CreateConditionInput): Promise<ConditionRow> {
  const db = getDb()
  const wallet = await upsertWallet(input.walletAddress, undefined, 'external')
  const [row] = await db
    .insert(automationConditions)
    .values({
      walletId: wallet.id,
      kind: input.kind,
      symbol: input.symbol,
      tokenAddress: input.tokenAddress,
      comparator: input.comparator,
      threshold: String(input.threshold),
      action: input.action ?? 'alert',
    })
    .returning()
  return row
}

export async function getConditionsForWallet(walletAddress: string, onlyEnabled = false): Promise<ConditionRow[]> {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  const rows = await db
    .select()
    .from(automationConditions)
    .where(
      onlyEnabled
        ? and(eq(automationConditions.walletId, wallet.id), eq(automationConditions.enabled, true))
        : eq(automationConditions.walletId, wallet.id),
    )
    .orderBy(desc(automationConditions.createdAt))
  return rows
}

// Every enabled condition across all wallets, joined to the owner address for the sweep.
export async function getAllEnabledConditions(): Promise<(ConditionRow & { address: string })[]> {
  const db = getDb()
  const rows = await db
    .select({ c: automationConditions, address: wallets.address })
    .from(automationConditions)
    .innerJoin(wallets, eq(wallets.id, automationConditions.walletId))
    .where(eq(automationConditions.enabled, true))
  return rows.map((r) => ({ ...r.c, address: r.address }))
}

export async function deleteCondition(walletAddress: string, conditionId: string): Promise<boolean> {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  const deleted = await db
    .delete(automationConditions)
    .where(and(eq(automationConditions.id, conditionId), eq(automationConditions.walletId, wallet.id)))
    .returning({ id: automationConditions.id })
  return deleted.length > 0
}

// Delete every condition matching a symbol (case-insensitive) for a wallet — powers
// "remove my ETH alert" without needing the exact id.
export async function deleteConditionsBySymbol(walletAddress: string, symbol: string): Promise<number> {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  const rows = await getConditionsForWallet(walletAddress)
  const ids = rows.filter((r) => (r.symbol ?? '').toLowerCase() === symbol.toLowerCase()).map((r) => r.id)
  let n = 0
  for (const id of ids) {
    const d = await db
      .delete(automationConditions)
      .where(and(eq(automationConditions.id, id), eq(automationConditions.walletId, wallet.id)))
      .returning({ id: automationConditions.id })
    n += d.length
  }
  return n
}

export async function markConditionTriggered(conditionId: string, observedValue: number): Promise<void> {
  const db = getDb()
  await db
    .update(automationConditions)
    .set({ lastTriggeredAt: new Date(), lastValue: String(observedValue) })
    .where(eq(automationConditions.id, conditionId))
}

// Clears the triggered state when a condition is no longer true — so it re-fires on the
// NEXT crossing (edge-triggered), not every sweep while it stays true.
export async function markConditionReset(conditionId: string, observedValue: number): Promise<void> {
  const db = getDb()
  await db
    .update(automationConditions)
    .set({ lastTriggeredAt: null, lastValue: String(observedValue) })
    .where(eq(automationConditions.id, conditionId))
}

export async function recordConditionEvent(walletId: string, conditionId: string, message: string, observedValue: number): Promise<void> {
  const db = getDb()
  await db.insert(automationConditionEvents).values({
    walletId,
    conditionId,
    message,
    observedValue: String(observedValue),
  })
}

export async function getRecentConditionEvents(walletAddress: string, limit = 20) {
  const db = getDb()
  const wallet = await upsertWallet(walletAddress, undefined, 'external')
  return db
    .select()
    .from(automationConditionEvents)
    .where(eq(automationConditionEvents.walletId, wallet.id))
    .orderBy(desc(automationConditionEvents.createdAt))
    .limit(limit)
}
