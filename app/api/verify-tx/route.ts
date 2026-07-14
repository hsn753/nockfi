import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, isHash } from 'viem'
import { nockChain } from '@/lib/chain'
import { updateTransactionVerification } from '@/lib/db/transactions'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'

export const dynamic = 'force-dynamic'

// Independent server-side confirmation that a transaction really landed on Robinhood
// Chain, using RPC_URL (the same endpoint every other balance/quote check in this app
// already relies on) rather than trusting whatever the browser's own wallet-client
// reported. Seen in prod: a delegated-wallet swap reported "Done! Swap
// executed" with a txHash, but neither wallet involved ever incremented its nonce and
// the hash doesn't exist on Robinhood Chain by any independent check (RPC, Blockscout).
// The client-side receipt wait that produced that false success cannot be trusted alone
// for a claim this consequential — this endpoint is the real check the client must pass
// before telling a user their swap executed.
// Await the audit write but never let it change the verification RESPONSE. A DB error
// here must not flip a real on-chain success into a "not_found" (the outer catch does
// exactly that), so each write is isolated in its own try/catch. We await rather than
// fire-and-forget because on Vercel serverless, work left pending after the response is
// returned is not guaranteed to run — the function can be frozen — which silently drops
// the audit write for fast confirmations.
async function safeUpdateVerification(
  txHash: string,
  status: 'success' | 'reverted' | 'not_found',
  blockNumber?: string,
): Promise<void> {
  try {
    await updateTransactionVerification(txHash, status, blockNumber)
  } catch (err) {
    console.error('[verify-tx] Could not update transaction audit log:', err)
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { txHash, walletAddress } = (body ?? {}) as { txHash?: string; walletAddress?: string }

  if (!txHash || !isHash(txHash)) {
    return NextResponse.json({ error: 'A valid txHash is required.' }, { status: 400 })
  }

  // This endpoint writes to the transactions audit table (verify_status), so it must be
  // authenticated — previously it was open, letting any caller overwrite arbitrary audit
  // rows by hash and probe which hashes exist. Require a valid Privy identity token bound
  // to the wallet the caller claims (same check every other authenticated route uses).
  if (!walletAddress) {
    return NextResponse.json({ error: 'walletAddress is required.' }, { status: 400 })
  }
  try {
    await requireAuthenticatedWallet(req, walletAddress)
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    return NextResponse.json({ error: 'Authentication failed.' }, { status: 401 })
  }

  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) {
    return NextResponse.json({ error: 'RPC_URL not configured' }, { status: 500 })
  }

  const client = createPublicClient({ chain: nockChain, transport: http(rpcUrl) })

  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` })
    const status = receipt.status === 'success' ? 'success' : 'reverted'

    // This is the sole writer of verify_status on the transactions audit table — keeps
    // the database in permanent agreement with what the user was actually told, since
    // this endpoint is already the app's sole authority on success/revert/not-found.
    // A missing row (nothing logged yet, or DB not provisioned) is a real, harmless
    // no-op, not an error.
    await safeUpdateVerification(txHash, status, receipt.blockNumber.toString())

    return NextResponse.json({
      found: true,
      status,
      blockNumber: receipt.blockNumber.toString(),
    })
  } catch (err) {
    // getTransactionReceipt throws if the hash isn't found (not yet mined, or never
    // broadcast at all) - both are real "not confirmed" states, not errors to hide.
    await safeUpdateVerification(txHash, 'not_found')
    return NextResponse.json({ found: false, status: 'not_found' })
  }
}
