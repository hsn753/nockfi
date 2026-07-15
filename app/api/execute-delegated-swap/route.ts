import { NextRequest, NextResponse } from 'next/server'
import { isAddress, parseUnits } from 'viem'
import { executeDelegatedTransaction } from '@/lib/privy-server'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { getRegisteredWalletIds } from '@/lib/db/delegated-wallet-events'

export const dynamic = 'force-dynamic'

// Executes a swap transaction on a wallet the user has already delegated to this app
// via Privy session signers (see the "Instant swaps" section in Settings). No wallet
// popup, no mobile approval — the Privy-side policy (see /api/admin/setup-session-policy)
// is what actually constrains what this can do, same as any other signer.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { walletId, address, transaction, sellToken } = (body ?? {}) as {
    walletId?: string
    address?: string
    transaction?: { to: string; data: string; value: string; gas: string }
    sellToken?: { address: string; decimals: number; amount: string }
  }

  if (!walletId || !address || !isAddress(address) || !transaction) {
    return NextResponse.json({ error: 'walletId, address, and transaction are required' }, { status: 400 })
  }
  if (!isAddress(transaction.to)) {
    return NextResponse.json({ error: 'Invalid transaction.to address' }, { status: 400 })
  }
  if (sellToken && !isAddress(sellToken.address)) {
    return NextResponse.json({ error: 'Invalid sellToken.address' }, { status: 400 })
  }

  // The delegated (instant-swap) path only ever executes 0x swaps: the Privy session
  // policy restricts the signer to the 0x AllowanceHolder router, and the client declines
  // every non-0x route for delegated wallets. Enforce the same target allowlist here so
  // the server never signs a delegated transaction to any other contract — independent of
  // the Privy policy being correctly configured. `data` is still opaque, but a swap can
  // only move funds via this router, and the sellToken approval below is granted to it.
  // Address verified on-chain (docs/ARCHITECTURE.md).
  const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734'
  if (transaction.to.toLowerCase() !== ZEROX_ALLOWANCE_HOLDER.toLowerCase()) {
    return NextResponse.json(
      { error: 'Delegated execution is restricted to the 0x swap router.' },
      { status: 400 },
    )
  }

  // Confirmed real gap before this check existed: anyone who knew a walletId+address
  // pair could ask this server to sign a transaction against it, constrained only by
  // the Privy spend-policy cap, not by any check that the caller actually owns it.
  try {
    await requireAuthenticatedWallet(req, address)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }

  // Auth above binds the *address* to the caller, but Privy signs by walletId (the address
  // is just the viem account label) — so an authenticated user could otherwise pass a
  // victim's walletId and have the server sign on the victim's delegated wallet, capped only
  // by the Privy policy. Bind walletId to the caller too: it must be one this same address
  // registered through the auth-guarded delegation flow. Fail closed if it isn't (or if the
  // wallet was never delegated), so we never sign a walletId the authenticated user doesn't own.
  const registered = await getRegisteredWalletIds(address)
  if (!registered.includes(walletId)) {
    return NextResponse.json(
      { error: 'This walletId is not a delegated instant-swap wallet registered to your account.' },
      { status: 403 },
    )
  }

  try {
    const result = await executeDelegatedTransaction(
      walletId,
      address as `0x${string}`,
      {
        to: transaction.to as `0x${string}`,
        data: transaction.data as `0x${string}`,
        value: BigInt(transaction.value || '0'),
        gas: BigInt(transaction.gas || '300000'),
      },
      sellToken
        ? {
            address: sellToken.address as `0x${string}`,
            decimals: sellToken.decimals,
            amountWei: parseUnits(sellToken.amount.replace(/,/g, ''), sellToken.decimals),
          }
        : undefined,
    )

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
