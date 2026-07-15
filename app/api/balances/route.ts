import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { fetchWalletBalances } from '@/lib/get-balances'
import { getStockBorrowPositions } from '@/lib/get-stock-collateral'
import { getWalletByAddress } from '@/lib/db/wallets'
import { getUnresolvedRiskEvents } from '@/lib/db/loan-risk'
import { getWeeklyBaseline } from '@/lib/db/portfolio-snapshots'
import { withRateLimit } from '@/lib/api-guard'
import { cached } from '@/lib/cache'

export const GET = withRateLimit('balances', 60, 10_000, handleGET)

async function handleGET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('address')

  if (!raw || !isAddress(raw)) {
    return NextResponse.json({ error: 'Invalid or missing address' }, { status: 400 })
  }

  try {
    // 15s per-wallet cache. This is the heaviest read (a ~50-token multicall + collateral
    // + DB) and the dashboard polls it every 60s per user — caching collapses repeated
    // polls (and any unauth amplification) for the same wallet to one refresh per 15s.
    const data = await cached(`balances:${raw.toLowerCase()}`, 15_000, async () => {
      // Resolve the wallet row once (it was previously fetched twice in one request).
      const wallet = await getWalletByAddress(raw).catch(() => null)
      // Collateral positions ride along with balances: stock posted as loan collateral is
      // still the user's asset (net of debt). Best-effort — a read failure here must not
      // take down the balances everything else depends on.
      const [balances, collateralPositions, riskEvents, weeklyBaseline] = await Promise.all([
        fetchWalletBalances(raw),
        getStockBorrowPositions(raw).catch((err) => {
          console.error('[/api/balances] Collateral positions fetch failed:', err)
          return []
        }),
        wallet ? getUnresolvedRiskEvents(wallet.id).catch(() => []) : Promise.resolve([]),
        wallet ? getWeeklyBaseline(wallet.id).catch(() => null) : Promise.resolve(null),
      ])

      const currentTotal =
        balances.reduce((s, b) => s + (b.usdValue ?? 0), 0) +
        collateralPositions.reduce((s, p) => s + (p.collateralValueUsd - p.borrowedUsd), 0)
      const weeklyChangePct =
        weeklyBaseline !== null && weeklyBaseline > 0
          ? ((currentTotal - weeklyBaseline) / weeklyBaseline) * 100
          : null

      return { balances, collateralPositions, riskEvents, weeklyChangePct }
    })

    return NextResponse.json(data)
  } catch (err) {
    console.error('[/api/balances] Error:', err)
    return NextResponse.json({ error: 'Failed to fetch balances from the chain' }, { status: 500 })
  }
}
