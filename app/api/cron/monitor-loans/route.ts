import { NextRequest, NextResponse } from 'next/server'
import { checkCronAuth } from '@/lib/internal-auth'
import { getDb } from '@/lib/db/client'
import { wallets } from '@/lib/db/schema'
import { getAllStockBorrowPositions } from '@/lib/get-stock-collateral'
import { syncLoanRiskEvents } from '@/lib/db/loan-risk'
import { fetchWalletBalances } from '@/lib/get-balances'
import { recordPortfolioSnapshot } from '@/lib/db/portfolio-snapshots'

// Scheduled sweep (vercel.json crons) over every wallet this app has ever seen:
// reads each one's live stock-collateral positions and reconciles persisted risk
// events — so a loan that crossed the risk threshold overnight greets its owner
// with a timestamped warning on their next visit instead of nothing. This is the
// only monitoring that runs while nobody has the app open; the client still does
// its own live check on every load, which is fresher for whoever is present.
//
// Vercel invokes this with `Authorization: Bearer ${CRON_SECRET}` — CRON_SECRET must
// be set in the project env (Vercel auto-injects the bearer for scheduled runs). This
// endpoint fails CLOSED: if the secret is missing/misconfigured, or the bearer doesn't
// match, we refuse. Previously, an unset CRON_SECRET skipped the check entirely, so any
// caller could trigger this per-wallet sweep (maxDuration 300, loops every wallet) — a
// cost/DoS amplification vector. Never let a missing config silently disable auth.

export const maxDuration = 300

export async function GET(req: NextRequest) {
  // Fail CLOSED (constant-time). Also enforced at the edge in middleware.ts — kept here
  // too so the handler is safe on its own, independent of middleware.
  if (!checkCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const db = getDb()
    const allWallets = await db.select({ id: wallets.id, address: wallets.address }).from(wallets)

    let opened = 0
    let resolved = 0
    let withLoans = 0

    // All wallets' positions in a handful of multicalls (one position read per
    // wallet×market, chunked; market state and oracle read once per market) —
    // ~3 RPC round-trips per 400 wallets rather than ~4 per wallet, so the sweep
    // stays inside the function budget at thousands of users.
    const allPositions = await getAllStockBorrowPositions(allWallets.map((w) => w.address))
    const checked = allWallets.length

    let snapshots = 0
    for (const w of allWallets) {
      try {
        const positions = allPositions.get(w.address.toLowerCase()) ?? []
        if (positions.length > 0) withLoans++
        const r = await syncLoanRiskEvents(w.id, positions)
        opened += r.opened
        resolved += r.resolved

        // Daily portfolio snapshot — the real history behind the dashboard's
        // "+x% this week" line. Wallet balances + collateral net of debt, the
        // same formula the dashboard total uses. Best-effort per wallet.
        try {
          const balances = await fetchWalletBalances(w.address as `0x${string}`)
          const walletUsd = balances.reduce((s, b) => s + (b.usdValue ?? 0), 0)
          const netCollateral = positions.reduce((s, p) => s + (p.collateralValueUsd - p.borrowedUsd), 0)
          if (await recordPortfolioSnapshot(w.id, walletUsd + netCollateral)) snapshots++
        } catch (err) {
          console.error(`[monitor-loans] Snapshot failed for ${w.address}:`, err)
        }
      } catch (err) {
        console.error(`[monitor-loans] Sync failed for ${w.address}:`, err)
      }
    }

    const summary = { checked, withLoans, eventsOpened: opened, eventsResolved: resolved, snapshots }
    console.log('[monitor-loans] Sweep complete:', summary)
    return NextResponse.json(summary)
  } catch (err) {
    console.error('[monitor-loans] Sweep failed:', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
