import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { fetchSwapQuote } from '@/lib/get-swap-quote'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Swap Agent: best-price route on Robinhood Chain (0x) + verified-token resolution.
// Returns an UNSIGNED transaction the caller signs and broadcasts itself.
export const GET = withApiKey('swap-quote', 60, 10_000, async (req) => {
  const sp = new URL(req.url).searchParams
  const fromToken = sp.get('fromToken')
  const toToken = sp.get('toToken')
  const amount = sp.get('amount')
  const taker = sp.get('taker') ?? undefined
  if (!fromToken || !toToken || !amount) {
    return NextResponse.json({ error: 'Missing required params: fromToken, toToken, amount' }, { status: 400 })
  }
  if (taker && !isAddress(taker)) {
    return NextResponse.json({ error: 'Invalid taker address' }, { status: 400 })
  }
  try {
    return NextResponse.json(await fetchSwapQuote({ fromToken, toToken, amount, taker }))
  } catch {
    return NextResponse.json({ error: 'Failed to fetch swap quote' }, { status: 502 })
  }
})
