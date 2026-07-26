import { NextRequest, NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/internal-auth'
import { runConditionSweep } from '@/lib/conditions-monitor'

// Evaluates every enabled user monitor-condition and fires alerts on crossings. Read-only
// (no funds move for v1 'alert' actions), so no automation-key gate — just cron auth.
// EU-box crontab, every ~10 min. Fails CLOSED on missing/wrong CRON_SECRET.

export const maxDuration = 300

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const summary = await runConditionSweep()
    console.log('[cron/conditions] Sweep complete:', summary)
    return NextResponse.json(summary)
  } catch (err) {
    console.error('[cron/conditions] Sweep failed:', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
