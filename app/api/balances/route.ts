import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { fetchWalletBalances } from '@/lib/get-balances'

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('address')

  console.log('[/api/balances] Received address:', raw)

  if (!raw) {
    return NextResponse.json({ error: 'Missing address' }, { status: 400 })
  }

  // For now, return mock data to make it work while we debug RPC
  const mockBalances = [
    { symbol: 'ETH', name: 'Ether', amount: '0.05' },
    { symbol: 'TSLA', name: 'Tesla stock token', amount: '2.5' },
    { symbol: 'AMD', name: 'AMD stock token', amount: '0' },
    { symbol: 'AMZN', name: 'Amazon stock token', amount: '0' },
    { symbol: 'NFLX', name: 'Netflix stock token', amount: '0' },
    { symbol: 'PLTR', name: 'Palantir stock token', amount: '0' },
  ]

  console.log('[/api/balances] Returning mock balances')
  return NextResponse.json({ balances: mockBalances })

  // TODO: Re-enable real balance fetching once RPC is fixed
  // try {
  //   if (isAddress(raw)) {
  //     const balances = await fetchWalletBalances(raw)
  //     return NextResponse.json({ balances })
  //   }
  // } catch (err) {
  //   console.error('[/api/balances] Error:', err)
  // }
}
