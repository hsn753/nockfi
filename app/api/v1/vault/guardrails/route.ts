import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getWalletByAddress } from '@/lib/db/wallets'
import { getGuardrails } from '@/lib/db/guardrails'
import { withApiKey } from '@/lib/api-key'

export const dynamic = 'force-dynamic'

// Vault Agent: the safety guardrails set for a wallet — currently the per-transaction USD
// spend limit that gates any swap/deposit. Partners can read it to mirror the same limit.
export const GET = withApiKey('vault-guardrails', 120, 10_000, async (req) => {
  const address = new URL(req.url).searchParams.get('address')
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'A valid ?address= is required.' }, { status: 400 })
  }
  try {
    const wallet = await getWalletByAddress(address)
    const guardrails = wallet ? await getGuardrails(wallet.id) : { maxUsdPerTransaction: null }
    return NextResponse.json({ address, ...guardrails })
  } catch {
    return NextResponse.json({ error: 'Could not read guardrails.' }, { status: 502 })
  }
})
