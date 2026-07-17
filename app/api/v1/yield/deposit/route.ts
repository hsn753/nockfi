import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { buildYieldDeposit } from '@/lib/get-yield-data'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Yield Agent — EXECUTABLE: "put $X to work." Builds the unsigned deposit transaction into
// the vault; the caller signs and broadcasts it. amount is in USDG.
export const GET = withApiKey('yield-deposit', 60, 10_000, async (req) => {
  const sp = new URL(req.url).searchParams
  const address = sp.get('address')
  const amount = sp.get('amount')
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'A valid ?address= is required.' }, { status: 400 })
  }
  if (!amount) return NextResponse.json({ error: '?amount= (USDG) is required.' }, { status: 400 })
  try {
    const result = await buildYieldDeposit(address, amount)
    if ('error' in result) return NextResponse.json(result, { status: 422 })
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Could not build the deposit.' }, { status: 502 })
  }
})
