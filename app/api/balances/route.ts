import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { fetchWalletBalances } from '@/lib/get-balances'

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('address')

  if (!raw || !isAddress(raw)) {
    return NextResponse.json({ error: 'Invalid or missing address' }, { status: 400 })
  }

  try {
    const balances = await fetchWalletBalances(raw)
    return NextResponse.json({ balances })
  } catch (err) {
    console.error('[/api/balances] Error:', err)
    return NextResponse.json({ error: 'Failed to fetch balances from the chain' }, { status: 500 })
  }
}
