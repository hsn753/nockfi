import { and, desc, eq, gte, lt } from 'drizzle-orm'
import { getDb } from './client'
import { portfolioSnapshots } from './schema'

// One snapshot per wallet per sweep, but never more than one per ~20h — the
// sweep is daily, and a manually re-triggered sweep must not double-record.
export async function recordPortfolioSnapshot(walletId: string, totalUsd: number): Promise<boolean> {
  const db = getDb()
  const [latest] = await db
    .select({ takenAt: portfolioSnapshots.takenAt })
    .from(portfolioSnapshots)
    .where(eq(portfolioSnapshots.walletId, walletId))
    .orderBy(desc(portfolioSnapshots.takenAt))
    .limit(1)
  if (latest && Date.now() - latest.takenAt.getTime() < 20 * 3600 * 1000) return false
  await db.insert(portfolioSnapshots).values({ walletId, totalUsd: totalUsd.toFixed(2) })
  return true
}

// The baseline for "this week": the OLDEST snapshot inside the last 8 days that
// is at least ~20h old (same-day snapshots would make the line read ~0% forever).
// Null when there's no usable history — the UI then shows nothing rather than a
// made-up number.
export async function getWeeklyBaseline(walletId: string): Promise<number | null> {
  const db = getDb()
  const now = Date.now()
  const [row] = await db
    .select({ totalUsd: portfolioSnapshots.totalUsd })
    .from(portfolioSnapshots)
    .where(and(
      eq(portfolioSnapshots.walletId, walletId),
      gte(portfolioSnapshots.takenAt, new Date(now - 8 * 24 * 3600 * 1000)),
      lt(portfolioSnapshots.takenAt, new Date(now - 20 * 3600 * 1000)),
    ))
    .orderBy(portfolioSnapshots.takenAt)
    .limit(1)
  if (!row) return null
  const base = parseFloat(row.totalUsd)
  return Number.isFinite(base) ? base : null
}
