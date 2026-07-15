import { sql, lt } from 'drizzle-orm'
import { getDb } from './client'
import { rateLimits } from './schema'

// Fixed-window rate limiter backed by Postgres so the count is shared across every
// serverless instance and the self-hosted origin (in-process memory doesn't persist
// across requests in this runtime). One atomic statement per check.
export async function consumeRateLimit(
  name: string,
  ip: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<{ allowed: boolean; count: number }> {
  const windowStart = Math.floor(now / windowMs) * windowMs
  const key = `${name}:${ip}:${windowStart}`
  const db = getDb()

  // INSERT ... ON CONFLICT DO UPDATE ... RETURNING is a single atomic row operation:
  // concurrent requests for the same key serialize on the row, so the returned count is
  // exact (no read-modify-write race).
  const rows = await db
    .insert(rateLimits)
    .values({ key, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count })

  const count = rows[0]?.count ?? 1
  return { allowed: count <= limit, count }
}

// Sweep stale window rows. Called opportunistically from the loan-monitor cron so the
// table can't grow unbounded — every row older than the cutoff belongs to a window that
// has long since closed.
export async function cleanupRateLimits(olderThanMs: number, now: number): Promise<void> {
  const db = getDb()
  await db.delete(rateLimits).where(lt(rateLimits.createdAt, new Date(now - olderThanMs)))
}
