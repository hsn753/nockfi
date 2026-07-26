import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { disableLiquidationProtectionByAddress } from '@/lib/db/liquidation-protection'

export const dynamic = 'force-dynamic'

// Safety operation — NOT gated behind the feature flag; turning protection off must always
// work. Does not revoke the on-chain grant (the client offers that separately); enabled=
// false is enough to stop the sweep from acting.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { address } = (body ?? {}) as { address?: string }

  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  try {
    await requireAuthenticatedWallet(req, address)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }

  try {
    await disableLiquidationProtectionByAddress(address)
    return NextResponse.json({ enabled: false })
  } catch (err) {
    console.error('[liquidation-protection/disable]', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
