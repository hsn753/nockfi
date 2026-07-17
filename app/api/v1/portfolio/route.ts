import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { fetchWalletBalances } from '@/lib/get-balances'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Cross-agent portfolio: on-chain token + stock-token holdings for any address, with USD.
export const GET = withApiKey('portfolio', 120, 10_000, async (req) => {
  const address = new URL(req.url).searchParams.get('address')
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'A valid ?address= is required.' }, { status: 400 })
  }
  try {
    const balances = await fetchWalletBalances(address as `0x${string}`)
    const totalPortfolioUsd = Number(balances.reduce((s, b) => s + (b.usdValue ?? 0), 0).toFixed(2))
    return NextResponse.json({ address, balances, totalPortfolioUsd })
  } catch {
    return NextResponse.json({ error: 'Could not read balances from the chain.' }, { status: 502 })
  }
})
