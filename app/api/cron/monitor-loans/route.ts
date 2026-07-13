import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db/client'
import { wallets } from '@/lib/db/schema'
import { getStockBorrowPositions } from '@/lib/get-stock-collateral'
import { syncLoanRiskEvents } from '@/lib/db/loan-risk'

// Scheduled sweep (vercel.json crons) over every wallet this app has ever seen:
// reads each one's live stock-collateral positions and reconciles persisted risk
// events — so a loan that crossed the risk threshold overnight greets its owner
// with a timestamped warning on their next visit instead of nothing. This is the
// only monitoring that runs while nobody has the app open; the client still does
// its own live check on every load, which is fresher for whoever is present.
//
// Vercel invokes this with `Authorization: Bearer ${CRON_SECRET}` when that env
// var is set — set it, since without it any caller can trigger a sweep (harmless
// but wasteful: this route reads public chain state and writes only risk rows).

export const maxDuration = 300

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const db = getDb()
    const allWallets = await db.select({ id: wallets.id, address: wallets.address }).from(wallets)

    let checked = 0
    let opened = 0
    let resolved = 0
    let withLoans = 0

    // Sequential on purpose: tens of wallets at most today, and parallel sweeps
    // would hammer the RPC and the oracle for no reason.
    for (const w of allWallets) {
      try {
        const positions = await getStockBorrowPositions(w.address)
        checked++
        if (positions.length > 0) withLoans++
        const r = await syncLoanRiskEvents(w.id, positions)
        opened += r.opened
        resolved += r.resolved
      } catch (err) {
        console.error(`[monitor-loans] Failed for ${w.address}:`, err)
      }
    }

    const summary = { checked, withLoans, eventsOpened: opened, eventsResolved: resolved }
    console.log('[monitor-loans] Sweep complete:', summary)
    return NextResponse.json(summary)
  } catch (err) {
    console.error('[monitor-loans] Sweep failed:', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
