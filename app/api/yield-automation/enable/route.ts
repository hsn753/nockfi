import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isHash } from 'viem'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { isAutomationAuthorized } from '@/lib/get-morpho-markets'
import { getAutomationAddress, yieldAutomationEnabled } from '@/lib/yield-automation'
import { enableYieldAutomation } from '@/lib/db/yield-automation'

export const dynamic = 'force-dynamic'

// Called AFTER the user's own wallet has signed + the client waited for the
// setAuthorization(automationAddress, true) receipt (see settings-view.tsx) — this route
// never itself grants anything on-chain. It only records the app's intent, and only after
// independently re-reading Morpho's own isAuthorized mapping — never trusting the client's
// claim that the tx succeeded.
export async function POST(req: NextRequest) {
  if (!yieldAutomationEnabled()) {
    return NextResponse.json({ error: 'Automated yield switching is not available right now.' }, { status: 503 })
  }

  const body = await req.json().catch(() => null)
  const { address, authTxHash } = (body ?? {}) as { address?: string; authTxHash?: string }

  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  if (!authTxHash || !isHash(authTxHash)) {
    return NextResponse.json({ error: 'Invalid authTxHash' }, { status: 400 })
  }

  try {
    await requireAuthenticatedWallet(req, address)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }

  try {
    const automationAddress = getAutomationAddress()
    const authorized = await isAutomationAuthorized(address, automationAddress)
    if (!authorized) {
      return NextResponse.json(
        { error: 'Authorization not found on-chain yet — wait for your transaction to confirm and try again.' },
        { status: 409 },
      )
    }
    await enableYieldAutomation(address, authTxHash)
    return NextResponse.json({ enabled: true })
  } catch (err) {
    console.error('[yield-automation/enable]', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
