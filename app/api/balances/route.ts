import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { fetchWalletBalances } from '@/lib/get-balances'
import { getStockBorrowPositions } from '@/lib/get-stock-collateral'
import { getWalletByAddress } from '@/lib/db/wallets'
import { getUnresolvedRiskEvents } from '@/lib/db/loan-risk'

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
    const [balances, collateralPositions, riskEvents] = await Promise.all([
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
    ])
    return NextResponse.json({ balances, collateralPositions, riskEvents })
  } catch (err) {
    console.error('[/api/balances] Error:', err)
    return NextResponse.json({ error: 'Failed to fetch balances from the chain' }, { status: 500 })
  }
}
