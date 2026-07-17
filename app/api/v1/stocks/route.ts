import { NextResponse } from 'next/server'
import { getStockTokens } from '@/lib/get-stock-tokens'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Stock Token Agent: the verified tokenized-equity universe (AAPL, TSLA, SPY, …),
// each checked against Robinhood's official issuer.
export const GET = withApiKey('stocks', 60, 10_000, async () => {
  try {
    return NextResponse.json({ stocks: await getStockTokens() })
  } catch {
    return NextResponse.json({ error: 'Could not fetch stock tokens.' }, { status: 502 })
  }
})
