import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, isHash } from 'viem'
import { nockChain } from '@/lib/chain'

export const dynamic = 'force-dynamic'

// Independent server-side confirmation that a transaction really landed on Robinhood
// Chain, using RPC_URL (the same endpoint every other balance/quote check in this app
// already relies on) rather than trusting whatever the browser's own wallet-client
// reported. Confirmed in production: a delegated-wallet swap reported "Done! Swap
// executed" with a txHash, but neither wallet involved ever incremented its nonce and
// the hash doesn't exist on Robinhood Chain by any independent check (RPC, Blockscout).
// The client-side receipt wait that produced that false success cannot be trusted alone
// for a claim this consequential — this endpoint is the real check the client must pass
// before telling a user their swap executed.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const { txHash } = (body ?? {}) as { txHash?: string }

  if (!txHash || !isHash(txHash)) {
    return NextResponse.json({ error: 'A valid txHash is required.' }, { status: 400 })
  }

  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) {
    return NextResponse.json({ error: 'RPC_URL not configured' }, { status: 500 })
  }

  const client = createPublicClient({ chain: nockChain, transport: http(rpcUrl) })

  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` })
    return NextResponse.json({
      found: true,
      status: receipt.status === 'success' ? 'success' : 'reverted',
      blockNumber: receipt.blockNumber.toString(),
    })
  } catch {
    // getTransactionReceipt throws if the hash isn't found (not yet mined, or never
    // broadcast at all) - both are real "not confirmed" states, not errors to hide.
    return NextResponse.json({ found: false, status: 'not_found' })
  }
}
