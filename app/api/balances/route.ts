import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { fetchWalletBalances } from '@/lib/get-balances'

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('address')

  console.log('[/api/balances] Received address:', raw)
  console.log('[/api/balances] isAddress check:', isAddress(raw || ''))

  if (!raw || !isAddress(raw)) {
    console.error('[/api/balances] Invalid address:', raw)
    return NextResponse.json({ error: 'Invalid or missing address' }, { status: 400 })
  }

  try {
    console.log('[/api/balances] Fetching balances for:', raw)
    const balances = await fetchWalletBalances(raw)
    console.log('[/api/balances] Success:', balances)
    return NextResponse.json({ balances })
  } catch (err) {
    console.error('[/api/balances] Error:', err)
    return NextResponse.json({ error: 'Failed to fetch balances' }, { status: 500 })
  }
}
