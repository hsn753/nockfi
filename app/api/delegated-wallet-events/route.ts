import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { logDelegatedWalletEvent } from '@/lib/db/delegated-wallet-events'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// Append-only log of instant-swap wallet lifecycle events (create/enable/disable/
// export), called from the four action handlers in components/nock/settings-view.tsx's
// InstantSwapsSection. Durable even if Privy's own dashboard-side policy or signer
// registration later changes — see lib/db/schema.ts's delegatedWalletEvents table.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { ownerWalletAddress, embeddedAddress, privyWalletId, signerId, policyId, eventType } =
    (body ?? {}) as Record<string, unknown>

  if (typeof ownerWalletAddress !== 'string' || !isAddress(ownerWalletAddress)) {
    return NextResponse.json({ error: 'A valid ownerWalletAddress is required.' }, { status: 400 })
  }

  try {
    await requireAuthenticatedWallet(req, ownerWalletAddress)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }
  if (typeof embeddedAddress !== 'string' || !isAddress(embeddedAddress)) {
    return NextResponse.json({ error: 'A valid embeddedAddress is required.' }, { status: 400 })
  }
  if (typeof privyWalletId !== 'string' || typeof signerId !== 'string' || typeof policyId !== 'string') {
    return NextResponse.json({ error: 'privyWalletId, signerId, and policyId are required.' }, { status: 400 })
  }
  if (!['created', 'enabled', 'disabled', 'export_initiated'].includes(eventType as string)) {
    return NextResponse.json({ error: 'Invalid eventType.' }, { status: 400 })
  }

  try {
    await logDelegatedWalletEvent({
      ownerWalletAddress,
      embeddedAddress,
      privyWalletId,
      signerId,
      policyId,
      eventType: eventType as 'created' | 'enabled' | 'disabled' | 'export_initiated',
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[delegated-wallet-events] Error:', err)
    return NextResponse.json({ error: 'Could not log this event.' }, { status: 500 })
  }
}
