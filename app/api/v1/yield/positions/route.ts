import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getUserMarketPositions } from '@/lib/get-morpho-markets'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Yield Agent: a wallet's live supply positions.
export const GET = withApiKey('yield-positions', 120, 10_000, async (req) => {
  const address = new URL(req.url).searchParams.get('address')
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'A valid ?address= is required.' }, { status: 400 })
  }
  try {
    return NextResponse.json({ positions: await getUserMarketPositions(address) })
  } catch {
    return NextResponse.json({ error: 'Could not read positions from the chain.' }, { status: 502 })
  }
})
