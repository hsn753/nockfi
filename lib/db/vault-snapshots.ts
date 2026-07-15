import { and, eq, gte, asc, desc } from 'drizzle-orm'
import { getDb } from './client'
import { vaultSnapshots } from './schema'

export async function recordSnapshot(vaultAddress: string, totalAssets: string, totalSupply: string): Promise<void> {
  const db = getDb()
  await db.insert(vaultSnapshots).values({
    vaultAddress: vaultAddress.toLowerCase(),
    totalAssets,
    totalSupply,
  })
}

const LOOKBACK_HOURS = 24
// Don't annualize off a tiny window — a sub-hour span compounds into wild, dishonest
// numbers. 6h is the minimum span we'll extrapolate from; below that we say "still
// collecting" rather than overstate precision.
const MIN_SPAN_HOURS = 6

// Derives APY from real recorded share-price growth (totalAssets/totalSupply) over the
// lookback window — never a guessed or hardcoded number. Returns null if there isn't
// enough real history yet spanning a meaningful window; the caller (lib/get-yield-data.ts)
// surfaces that as "still collecting rate data" rather than fabricating a percentage.
export async function computeApy(vaultAddress: string): Promise<number | null> {
  const db = getDb()
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000)
  const normalized = vaultAddress.toLowerCase()

  const [oldest, newest] = await Promise.all([
    db
      .select()
      .from(vaultSnapshots)
      .where(and(eq(vaultSnapshots.vaultAddress, normalized), gte(vaultSnapshots.recordedAt, since)))
      .orderBy(asc(vaultSnapshots.recordedAt))
      .limit(1),
    db
      .select()
      .from(vaultSnapshots)
      .where(eq(vaultSnapshots.vaultAddress, normalized))
      .orderBy(desc(vaultSnapshots.recordedAt))
      .limit(1),
  ])

  if (!oldest[0] || !newest[0] || oldest[0].id === newest[0].id) return null

  const spanMs = newest[0].recordedAt.getTime() - oldest[0].recordedAt.getTime()
  const spanHours = spanMs / (60 * 60 * 1000)
  if (spanHours < MIN_SPAN_HOURS) return null

  const oldSharePrice = Number(oldest[0].totalAssets) / Number(oldest[0].totalSupply)
  const newSharePrice = Number(newest[0].totalAssets) / Number(newest[0].totalSupply)
  if (!Number.isFinite(oldSharePrice) || !Number.isFinite(newSharePrice) || oldSharePrice <= 0) return null

  const growthRate = (newSharePrice - oldSharePrice) / oldSharePrice
  const periodsPerYear = (365 * 24) / spanHours
  // True compound APY, not a linear APR mislabeled as APY: the share price grows each
  // period on the prior period's balance. (Base can't go non-positive here — growthRate
  // > -1 given oldSharePrice > 0 and a non-negative newSharePrice — but guard anyway.)
  const apy = Math.pow(1 + growthRate, periodsPerYear) - 1

  // A share price can dip transiently (e.g. rounding, a large same-block withdrawal), and
  // compounding noisy short-window growth can explode — clamp to a sane display range and
  // treat anything outside it (or non-finite) as "not enough clean data yet".
  if (!Number.isFinite(apy) || apy < -0.5 || apy > 2) return null

  return apy
}
