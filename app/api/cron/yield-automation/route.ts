import { NextRequest, NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/internal-auth'
import { runYieldAutomationSweep, yieldAutomationEnabled } from '@/lib/yield-automation'

// Scheduled sweep (vercel.json crons on Vercel; EU-box crontab elsewhere — same
// Authorization: Bearer ${CRON_SECRET} pattern as monitor-loans) over every wallet that
// has opted into automated yield rebalancing. See lib/yield-automation.ts for the actual
// logic; this route is just the auth-gated entrypoint. Fails CLOSED like monitor-loans:
// a missing/misconfigured CRON_SECRET refuses rather than silently skipping auth.

export const maxDuration = 300

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Belt-and-suspenders: even if this cron entry somehow got scheduled against an
  // environment without the automation key configured (see YIELD_AUTOMATION_ENABLED in
  // lib/feature-flags.ts), refuse rather than let runYieldAutomationSweep throw per-wallet.
  if (!yieldAutomationEnabled()) {
    return NextResponse.json({ error: 'Yield automation is not configured on this environment.' }, { status: 503 })
  }

  try {
    const summary = await runYieldAutomationSweep()
    console.log('[cron/yield-automation] Sweep complete:', summary)
    return NextResponse.json(summary)
  } catch (err) {
    console.error('[cron/yield-automation] Sweep failed:', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
