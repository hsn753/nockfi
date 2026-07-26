import { NextRequest, NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/internal-auth'
import { runPortfolioRebalanceSweep, portfolioRebalanceEnabled } from '@/lib/portfolio-rebalance'

// Rebalances every wallet with an enabled target allocation whose drift exceeds its
// threshold. EU-box crontab (hourly — allocation drift is slow; no need to churn gas
// often). Same CRON_SECRET bearer; fails CLOSED. See lib/portfolio-rebalance.ts.

export const maxDuration = 300

export async function GET(req: NextRequest) {
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!portfolioRebalanceEnabled()) {
    return NextResponse.json({ error: 'Portfolio rebalancing is not configured on this environment.' }, { status: 503 })
  }
  try {
    const summary = await runPortfolioRebalanceSweep()
    console.log('[cron/portfolio-rebalance] Sweep complete:', summary)
    return NextResponse.json(summary)
  } catch (err) {
    console.error('[cron/portfolio-rebalance] Sweep failed:', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
