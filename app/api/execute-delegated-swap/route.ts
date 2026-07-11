import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { executeDelegatedTransaction } from '@/lib/privy-server'

export const dynamic = 'force-dynamic'

// Executes a swap transaction on a wallet the user has already delegated to this app
// via Privy session signers (see the "Instant swaps" section in Settings). No wallet
// popup, no mobile approval — the Privy-side policy (see /api/admin/setup-session-policy)
// is what actually constrains what this can do, same as any other signer.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { walletId, address, transaction } = (body ?? {}) as {
    walletId?: string
    address?: string
    transaction?: { to: string; data: string; value: string; gas: string }
  }

  if (!walletId || !address || !isAddress(address) || !transaction) {
    return NextResponse.json({ error: 'walletId, address, and transaction are required' }, { status: 400 })
  }
  if (!isAddress(transaction.to)) {
    return NextResponse.json({ error: 'Invalid transaction.to address' }, { status: 400 })
  }

  try {
    const result = await executeDelegatedTransaction(walletId, address as `0x${string}`, {
      to: transaction.to as `0x${string}`,
      data: transaction.data as `0x${string}`,
      value: BigInt(transaction.value || '0'),
      gas: BigInt(transaction.gas || '300000'),
    })

    if (result.error) {
      return NextResponse.json({ error: result.error, txHash: result.txHash }, { status: 422 })
    }

    return NextResponse.json({ txHash: result.txHash })
  } catch (err) {
    console.error('[execute-delegated-swap] Error:', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
