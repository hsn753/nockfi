import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { fetchWalletBalances } from '@/lib/get-balances'
import { getStockBorrowPositions } from '@/lib/get-stock-collateral'

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
    const [balances, collateralPositions] = await Promise.all([
      fetchWalletBalances(raw),
      getStockBorrowPositions(raw).catch((err) => {
        console.error('[/api/balances] Collateral positions fetch failed:', err)
        return []
      }),
    ])
    return NextResponse.json({ balances, collateralPositions })
  } catch (err) {
    console.error('[/api/balances] Error:', err)
    return NextResponse.json({ error: 'Failed to fetch balances from the chain' }, { status: 500 })
  }
}
