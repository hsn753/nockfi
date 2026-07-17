import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getStockBorrowPositions } from '@/lib/get-stock-collateral'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Stock Token Agent — lending: a wallet's open loans against stock-token collateral, with
// debt owed, collateral value, and liquidation price.
export const GET = withApiKey('collateral-positions', 120, 10_000, async (req) => {
  const address = new URL(req.url).searchParams.get('address')
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'A valid ?address= is required.' }, { status: 400 })
  }
  try {
    return NextResponse.json({ positions: await getStockBorrowPositions(address) })
  } catch {
    return NextResponse.json({ error: 'Could not read borrow positions.' }, { status: 502 })
  }
})
