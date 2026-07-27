import { sql } from 'drizzle-orm'
import { getDb } from './db/client'

// Cross-process mutex for the ONE shared automation key. pm2 runs the app as 2 cluster
// workers (separate Node processes) — an in-process boolean (like the conditions sweep's
// old `conditionSweepRunning`) only prevents overlap within a single worker. Two sweeps
// (different cron cadences, or a slow prior run still in flight) landing on different
// workers can still race on the automation key's nonce — the exact class of bug that
// already stranded a user's token once (see the strategy-execution.ts history). This uses
// Postgres row-level locking as the mutex instead: a single atomic INSERT..ON CONFLICT..
// WHERE either claims the row or is a no-op, so it's safe across any number of processes
// and doesn't require holding a live connection open (works fine over the stateless
// neon-http driver).
const LOCK_ROW_ID = 'automation-key'
// Self-heals if a holder crashed mid-sweep without releasing — must stay comfortably
// longer than any single sweep is expected to take, but short enough that a genuine crash
// doesn't wedge automation for long.
const STALE_INTERVAL_SQL = sql`interval '10 minutes'`

async function tryAcquire(holder: string): Promise<boolean> {
  const db = getDb()
  const rows = await db.execute(sql`
    INSERT INTO automation_lock (id, locked_by, locked_at)
    VALUES (${LOCK_ROW_ID}, ${holder}, now())
    ON CONFLICT (id) DO UPDATE
      SET locked_by = EXCLUDED.locked_by, locked_at = EXCLUDED.locked_at
      WHERE automation_lock.locked_by IS NULL
         OR automation_lock.locked_at < now() - ${STALE_INTERVAL_SQL}
    RETURNING id
  `)
  return rows.rows.length > 0
}

async function release(holder: string): Promise<void> {
  const db = getDb()
  await db.execute(sql`
    UPDATE automation_lock SET locked_by = NULL, locked_at = NULL
    WHERE id = ${LOCK_ROW_ID} AND locked_by = ${holder}
  `)
}

// Runs `fn` only if the automation key isn't currently in use elsewhere (any sweep, any
// worker). Returns null (a clean no-op, same as the old single-flight skip) if busy.
export async function withAutomationLock<T>(sweepName: string, fn: () => Promise<T>): Promise<T | null> {
  const holder = `${sweepName}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  if (!(await tryAcquire(holder))) return null
  try {
    return await fn()
  } finally {
    await release(holder)
  }
}
