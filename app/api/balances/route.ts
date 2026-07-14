import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { fetchWalletBalances } from '@/lib/get-balances'
import { getStockBorrowPositions } from '@/lib/get-stock-collateral'
import { getWalletByAddress } from '@/lib/db/wallets'
import { getUnresolvedRiskEvents } from '@/lib/db/loan-risk'
import { getWeeklyBaseline } from '@/lib/db/portfolio-snapshots'

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('address')

  if (!raw || !isAddress(raw)) {
    return NextResponse.json({ error: 'Invalid or missing address' }, { status: 400 })
  }

  try {
    // Collateral positions ride along with balances: stock posted as loan
    // collateral is still the user's asset (net of debt) — without it the
    // dashboard's portfolio number silently drops by the full collateral value
    // the moment a loan opens. Best-effort: a collateral read failure must not
    // take down the balances everything else depends on.
    const [balances, collateralPositions, riskEvents, weeklyBaseline] = await Promise.all([
      fetchWalletBalances(raw),
      getStockBorrowPositions(raw).catch((err) => {
        console.error('[/api/balances] Collateral positions fetch failed:', err)
        return []
      }),
      // Unresolved risk events persisted by the monitoring sweep — the "your loan
      // crossed the threshold while you were away" record, timestamped. Best-effort.
      (async () => {
        const wallet = await getWalletByAddress(raw)
        return wallet ? getUnresolvedRiskEvents(wallet.id) : []
      })().catch((err) => {
        console.error('[/api/balances] Risk events fetch failed:', err)
        return []
      }),
      // Real weekly baseline from the daily snapshot history (null until at
      // least one day-old snapshot exists — the UI hides the line rather than
      // ever inventing a percentage).
      (async () => {
        const wallet = await getWalletByAddress(raw)
        return wallet ? getWeeklyBaseline(wallet.id) : null
      })().catch(() => null),
    ])

    const currentTotal =
      balances.reduce((s, b) => s + (b.usdValue ?? 0), 0) +
      collateralPositions.reduce((s, p) => s + (p.collateralValueUsd - p.borrowedUsd), 0)
    const weeklyChangePct =
      weeklyBaseline !== null && weeklyBaseline > 0
        ? ((currentTotal - weeklyBaseline) / weeklyBaseline) * 100
        : null

    return NextResponse.json({ balances, collateralPositions, riskEvents, weeklyChangePct })
  } catch (err) {
    console.error('[/api/balances] Error:', err)
    return NextResponse.json({ error: 'Failed to fetch balances from the chain' }, { status: 500 })
  }
}
