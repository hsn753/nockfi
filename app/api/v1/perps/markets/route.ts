import { NextResponse } from 'next/server'
import { getPerpsMarkets } from '@/lib/get-perps-data'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Perps Agent: live perpetual-futures market data on Robinhood Chain (via Lighter) —
// mark price, hourly funding, open interest, 24h volume, max leverage. Read-only data;
// live order execution is jurisdiction-gated and not exposed here.
export const GET = withApiKey('perps-markets', 60, 10_000, async (req) => {
  const symbol = new URL(req.url).searchParams.get('symbol') ?? undefined
  try {
    return NextResponse.json(await getPerpsMarkets(symbol))
  } catch {
    return NextResponse.json({ error: 'Could not fetch perps markets.' }, { status: 502 })
  }
})
