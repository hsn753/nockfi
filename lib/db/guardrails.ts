import { eq, sql } from 'drizzle-orm'
import { getDb } from './client'
import { walletGuardrails } from './schema'

// null means unlimited — the honest default until a user explicitly sets a limit,
// never a fabricated number.
export async function getGuardrails(walletId: string): Promise<{ maxUsdPerTransaction: number | null }> {
  const db = getDb()
  const [row] = await db
    .select({ maxUsdPerTransaction: walletGuardrails.maxUsdPerTransaction })
    .from(walletGuardrails)
    .where(eq(walletGuardrails.walletId, walletId))
    .limit(1)

  return { maxUsdPerTransaction: row?.maxUsdPerTransaction != null ? Number(row.maxUsdPerTransaction) : null }
}

export async function setGuardrails(walletId: string, maxUsdPerTransaction: number): Promise<void> {
  const db = getDb()
  await db
    .insert(walletGuardrails)
    .values({ walletId, maxUsdPerTransaction: maxUsdPerTransaction.toString() })
    .onConflictDoUpdate({
      target: walletGuardrails.walletId,
      set: { maxUsdPerTransaction: maxUsdPerTransaction.toString(), updatedAt: sql`now()` },
    })
}
