import { NextRequest, NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/internal-auth'
import { runLiquidationProtectionSweep, liquidationProtectionEnabled } from '@/lib/liquidation-protection'

// Frequent sweep (EU-box crontab; every ~15 min) — liquidation risk moves fast, so this
// runs far more often than the daily monitor-loans alert cron. Same CRON_SECRET bearer +
// checkCronAuth pattern; fails CLOSED. See lib/liquidation-protection.ts for the logic.

export const maxDuration = 300

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!liquidationProtectionEnabled()) {
    return NextResponse.json({ error: 'Liquidation protection is not configured on this environment.' }, { status: 503 })
  }

  try {
    const summary = await runLiquidationProtectionSweep()
    console.log('[cron/liquidation-protection] Sweep complete:', summary)
    return NextResponse.json(summary)
  } catch (err) {
    console.error('[cron/liquidation-protection] Sweep failed:', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
