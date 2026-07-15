import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getUserMarketPositions, getMorphoMarketData } from '@/lib/get-morpho-markets'
import { withRateLimit } from '@/lib/api-guard'
import { cached } from '@/lib/cache'

export const dynamic = 'force-dynamic'

// Live on-chain yield positions for the dashboard's yield card — same public-read
// pattern as /api/balances (positions are public chain state keyed by address; no
// auth needed for reads, unlike the write/quote routes).
export const GET = withRateLimit('yield-positions', 60, 10_000, handleGET)

async function handleGET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'A valid address is required.' }, { status: 400 })
  }

  try {
    // 20s per-wallet cache — polled every 60s per user; caching collapses the poll to one
    // refresh per 20s (and the shared market APYs are already cached in getMorphoMarketData).
    const data = await cached(`yield-positions:${address.toLowerCase()}`, 20_000, async () => {
      const [positions, markets] = await Promise.all([
        getUserMarketPositions(address),
        getMorphoMarketData(),
      ])
      // Sub-cent dust remainders (share-rounding leftovers after a full withdrawal)
      // would otherwise show as "$0.00" rows forever.
      const withApy = positions
        .filter((p) => p.suppliedUsd >= 0.01)
        .map((p) => ({
          ...p,
          apyPct: markets.find((m) => m.key === p.market)?.supplyApyPct ?? null,
        }))
      return { positions: withApy }
    })
    return NextResponse.json(data)
  } catch (err) {
    console.error('[yield-positions] Error:', err)
    return NextResponse.json({ error: 'Could not read positions from the chain.' }, { status: 500 })
  }
}
