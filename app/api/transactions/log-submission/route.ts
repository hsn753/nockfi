import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { logTransactionSubmission } from '@/lib/db/transactions'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// Phase 1 of the transaction audit-trail write, called from handleLoose in
// components/nock/nock-app.tsx right after a swap attempt resolves (whether or not it
// produced a real txHash).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const {
    txHash, chainId, walletAddress, signerAddress, signerType, privyWalletId,
    agent, actionId, fromTokenSymbol, fromTokenAddress, fromAmount,
    toTokenSymbol, toTokenAddress, toAmount, quoteJson, broadcastStatus, errorMessage,
  } = (body ?? {}) as Record<string, unknown>

  if (typeof walletAddress !== 'string' || !isAddress(walletAddress)) {
    return NextResponse.json({ error: 'A valid walletAddress is required.' }, { status: 400 })
  }

  try {
    await requireAuthenticatedWallet(req, walletAddress)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }
  if (typeof signerAddress !== 'string' || !isAddress(signerAddress)) {
    return NextResponse.json({ error: 'A valid signerAddress is required.' }, { status: 400 })
  }
  if (signerType !== 'external' && signerType !== 'delegated') {
    return NextResponse.json({ error: "signerType must be 'external' or 'delegated'." }, { status: 400 })
  }
  if (broadcastStatus !== 'submitted' && broadcastStatus !== 'no_hash_returned' && broadcastStatus !== 'client_error') {
    return NextResponse.json({ error: 'Invalid broadcastStatus.' }, { status: 400 })
  }
  if (typeof agent !== 'string') {
    return NextResponse.json({ error: 'agent is required.' }, { status: 400 })
  }

  try {
    const row = await logTransactionSubmission({
      txHash: typeof txHash === 'string' && txHash !== '0x' ? txHash : null,
      chainId: typeof chainId === 'number' ? chainId : undefined,
      walletAddress,
      signerAddress,
      signerType,
      privyWalletId: typeof privyWalletId === 'string' ? privyWalletId : undefined,
      agent,
      actionId: typeof actionId === 'string' ? actionId : undefined,
      fromTokenSymbol: typeof fromTokenSymbol === 'string' ? fromTokenSymbol : undefined,
      fromTokenAddress: typeof fromTokenAddress === 'string' ? fromTokenAddress : undefined,
      fromAmount: typeof fromAmount === 'string' ? fromAmount : undefined,
      toTokenSymbol: typeof toTokenSymbol === 'string' ? toTokenSymbol : undefined,
      toTokenAddress: typeof toTokenAddress === 'string' ? toTokenAddress : undefined,
      toAmount: typeof toAmount === 'string' ? toAmount : undefined,
      quoteJson,
      broadcastStatus,
      errorMessage: typeof errorMessage === 'string' ? errorMessage : undefined,
    })
    return NextResponse.json({ id: row.id })
  } catch (err) {
    console.error('[log-submission] Error:', err)
    return NextResponse.json({ error: 'Could not log this transaction attempt.' }, { status: 500 })
  }
}
