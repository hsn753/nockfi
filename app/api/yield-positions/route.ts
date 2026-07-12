import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getUserMarketPositions, getMorphoMarketData } from '@/lib/get-morpho-markets'

export const dynamic = 'force-dynamic'

// Live on-chain yield positions for the dashboard's yield card — same public-read
// pattern as /api/balances (positions are public chain state keyed by address; no
// auth needed for reads, unlike the write/quote routes).
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'A valid address is required.' }, { status: 400 })
  }

  try {
    const [positions, markets] = await Promise.all([
      getUserMarketPositions(address),
      getMorphoMarketData(),
    ])
    const withApy = positions.map((p) => ({
      ...p,
      apyPct: markets.find((m) => m.key === p.market)?.supplyApyPct ?? null,
    }))
    return NextResponse.json({ positions: withApy })
  } catch (err) {
    console.error('[yield-positions] Error:', err)
    return NextResponse.json({ error: 'Could not read positions from the chain.' }, { status: 500 })
  }
}
