import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { isAutomationAuthorized } from '@/lib/get-morpho-markets'
import { getAutomationAddress } from '@/lib/yield-automation'
import { liquidationProtectionEnabled } from '@/lib/liquidation-protection'
import { enableLiquidationProtection } from '@/lib/db/liquidation-protection'

export const dynamic = 'force-dynamic'

// Turns on auto-repay liquidation protection. Requires the SAME Morpho setAuthorization
// grant as yield automation (global per address) — so a user who already authorized for
// auto-switch is already authorized here and needs no new signature; a user who hasn't
// must send it first (authTxHash carries the tx if they just did). Independently
// re-verifies isAuthorized on-chain before recording, never trusts the client's claim.
export async function POST(req: NextRequest) {
  if (!liquidationProtectionEnabled()) {
    return NextResponse.json({ error: 'Liquidation protection is not available right now.' }, { status: 503 })
  }

  const body = await req.json().catch(() => null)
  const { address, authTxHash } = (body ?? {}) as { address?: string; authTxHash?: string | null }

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
    const authorized = await isAutomationAuthorized(address, getAutomationAddress())
    if (!authorized) {
      return NextResponse.json(
        { error: 'not_authorized', message: 'On-chain authorization not found yet — approve it and try again.' },
        { status: 409 },
      )
    }
    await enableLiquidationProtection(address, authTxHash ?? null)
    return NextResponse.json({ enabled: true })
  } catch (err) {
    console.error('[liquidation-protection/enable]', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
