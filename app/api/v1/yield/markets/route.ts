import { NextResponse } from 'next/server'
import { getYieldOptions } from '@/lib/get-yield-data'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Yield Agent: available lending/vault markets with live APY (Morpho, Steakhouse).
export const GET = withApiKey('yield-markets', 60, 10_000, async () => {
  try {
    return NextResponse.json({ markets: await getYieldOptions() })
  } catch {
    return NextResponse.json({ error: 'Could not fetch yield markets.' }, { status: 502 })
  }
})
