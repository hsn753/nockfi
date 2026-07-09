import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { fetchSwapQuote } from '@/lib/get-swap-quote'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const fromToken = searchParams.get('fromToken')
  const toToken   = searchParams.get('toToken')
  const amount    = searchParams.get('amount')
  const taker     = searchParams.get('taker') ?? undefined

  if (!fromToken || !toToken || !amount) {
    return NextResponse.json(
      { error: 'Missing required params: fromToken, toToken, amount' },
      { status: 400 },
    )
  }
  if (taker && !isAddress(taker)) {
    return NextResponse.json({ error: 'Invalid taker address' }, { status: 400 })
  }

  try {
    const quote = await fetchSwapQuote({ fromToken, toToken, amount, taker })
    return NextResponse.json(quote)
  } catch (err) {
    console.error('[/api/swap-quote]', err)
    return NextResponse.json({ error: 'Failed to fetch swap quote' }, { status: 500 })
  }
}
