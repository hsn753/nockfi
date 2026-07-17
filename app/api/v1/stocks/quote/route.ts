import { NextResponse } from 'next/server'
import { findStockToken } from '@/lib/get-stock-tokens'
import { fetchUniswapStockQuote } from '@/lib/get-uniswap-quote'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Stock Token Agent: a buy/sell quote for a tokenized stock, routed through Uniswap.
// direction=buy → amount is USDG; direction=sell → amount is stock units.
export const GET = withApiKey('stocks-quote', 60, 10_000, async (req) => {
  const sp = new URL(req.url).searchParams
  const symbol = sp.get('symbol')
  const direction = sp.get('direction')
  const amount = sp.get('amount')
  if (!symbol || (direction !== 'buy' && direction !== 'sell') || !amount) {
    return NextResponse.json({ error: 'Params: symbol, direction (buy|sell), amount' }, { status: 400 })
  }
  try {
    const stock = await findStockToken(symbol)
    if (!stock) return NextResponse.json({ error: `Unknown stock token: ${symbol}` }, { status: 404 })
    const quote = await fetchUniswapStockQuote({ stockAddress: stock.address, stockSymbol: stock.symbol, direction, amount })
    return NextResponse.json(quote)
  } catch {
    return NextResponse.json({ error: 'Failed to fetch stock quote' }, { status: 502 })
  }
})
