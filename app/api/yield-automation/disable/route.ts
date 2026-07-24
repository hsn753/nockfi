import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { disableYieldAutomationByAddress } from '@/lib/db/yield-automation'

export const dynamic = 'force-dynamic'

// Turns off the app's OWN automated sweeping. Does not itself revoke the on-chain
// setAuthorization — the client separately offers that as a real on-chain tx (belt and
// suspenders: a user who only disables here still has an authorized address on Morpho
// until they also revoke, so the Settings UI should make both steps visible).
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
    await disableYieldAutomationByAddress(address)
    return NextResponse.json({ enabled: false })
  } catch (err) {
    console.error('[yield-automation/disable]', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
