import { NextResponse } from 'next/server'
import { getStockCollateralMarketData } from '@/lib/get-stock-collateral'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Stock Token Agent — lending: which tokenized stocks can back a USDG loan, with live
// borrow APY, LTV, and available liquidity (Morpho markets).
export const GET = withApiKey('collateral-markets', 60, 10_000, async () => {
  try {
    return NextResponse.json({ markets: await getStockCollateralMarketData() })
  } catch {
    return NextResponse.json({ error: 'Could not fetch collateral markets.' }, { status: 502 })
  }
})
