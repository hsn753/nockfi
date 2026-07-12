import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getGuardrails, setGuardrails } from '@/lib/db/guardrails'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// The real, user-configurable half of Vault Agent's spend limit — see
// lib/db/schema.ts's walletGuardrails table and the enforcement check in
// app/api/robin/route.ts's propose_action handler.
export async function GET(req: NextRequest) {
  const walletAddress = req.nextUrl.searchParams.get('walletAddress')
  if (!walletAddress || !isAddress(walletAddress)) {
    return NextResponse.json({ error: 'A valid walletAddress is required.' }, { status: 400 })
  }

  try {
    const { walletId } = await requireAuthenticatedWallet(req, walletAddress)
    const guardrails = await getGuardrails(walletId)
    return NextResponse.json(guardrails)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[guardrails] GET error:', err)
    return NextResponse.json({ error: 'Could not read guardrails.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { walletAddress, maxUsdPerTransaction } = (body ?? {}) as Record<string, unknown>

  if (typeof walletAddress !== 'string' || !isAddress(walletAddress)) {
    return NextResponse.json({ error: 'A valid walletAddress is required.' }, { status: 400 })
  }
  if (typeof maxUsdPerTransaction !== 'number' || !Number.isFinite(maxUsdPerTransaction) || maxUsdPerTransaction <= 0) {
    return NextResponse.json({ error: 'maxUsdPerTransaction must be a positive number.' }, { status: 400 })
  }

  try {
    const { walletId } = await requireAuthenticatedWallet(req, walletAddress)
    await setGuardrails(walletId, maxUsdPerTransaction)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[guardrails] POST error:', err)
    return NextResponse.json({ error: 'Could not save this limit.' }, { status: 500 })
  }
}
