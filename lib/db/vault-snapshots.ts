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
const MIN_SPAN_HOURS = 1 // don't annualize off two snapshots minutes apart — too noisy to be honest

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
  const apy = growthRate * periodsPerYear

  // A share price can dip transiently (e.g. rounding, a large same-block withdrawal) —
  // clamp to a sane display range rather than showing a nonsensical negative or
  // triple-digit APY off noisy short-window data.
  if (apy < -0.5 || apy > 2) return null

  return apy
}
