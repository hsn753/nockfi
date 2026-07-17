import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { buildStockBorrow } from '@/lib/get-stock-collateral'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Stock Token Agent — EXECUTABLE: borrow USDG against tokenized-stock collateral (e.g. post
// TSLA, borrow USDG). Returns the ordered step transactions + any required ERC-20 approval,
// plus the resulting LTV, borrow APY, and liquidation price. The caller signs each step.
export const GET = withApiKey('collateral-borrow', 60, 10_000, async (req) => {
  const sp = new URL(req.url).searchParams
  const address = sp.get('address')
  const stock = sp.get('stock')
  const borrowUsd = sp.get('borrowUsd')
  const collateralAmount = sp.get('collateralAmount') ?? undefined
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'A valid ?address= is required.' }, { status: 400 })
  }
  if (!stock || !borrowUsd) {
    return NextResponse.json({ error: 'Params: stock (symbol), borrowUsd (and optional collateralAmount in stock units).' }, { status: 400 })
  }
  try {
    const result = await buildStockBorrow(address, stock, borrowUsd, collateralAmount)
    if ('error' in result) return NextResponse.json(result, { status: 422 })
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Could not build the borrow.' }, { status: 502 })
  }
})
