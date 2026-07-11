import { NextRequest, NextResponse } from 'next/server'
import { formatUnits, isAddress } from 'viem'

export const dynamic = 'force-dynamic'

const BLOCKSCOUT_BASE = 'https://robinhoodchain.blockscout.com'
const ZEROX_ROUTER = '0x0000000000001ff3684f28c67538d4d072c22734'

export type ActivityEntry = {
  hash: string
  label: string
  detail: string
  status: 'success' | 'failed' | 'pending'
  timestamp: string
  explorerUrl: string
}

type BlockscoutTx = {
  hash: string
  to: { hash: string } | null
  from: { hash: string } | null
  value: string
  method: string | null
  result: string
  timestamp: string
}

// Real on-chain activity for the connected wallet, not a client-side log of only what
// happened through Nock's own chat in the current browser session — that ephemeral
// approach couldn't show anything done outside the app (e.g. a manual send from an
// exported wallet) and reset on every page refresh.
function describeTransaction(tx: BlockscoutTx, address: string): { label: string; detail: string } {
  const toAddr = tx.to?.hash?.toLowerCase()
  const isFromMe = tx.from?.hash?.toLowerCase() === address.toLowerCase()
  const valueEth = parseFloat(formatUnits(BigInt(tx.value || '0'), 18))

  if (toAddr === ZEROX_ROUTER) {
    return { label: 'Swap', detail: valueEth > 0 ? `${valueEth.toLocaleString('en-US', { maximumFractionDigits: 6 })} ETH sold` : 'Token sale' }
  }
  if (tx.method === 'approve') {
    return { label: 'Approved token spend', detail: 'Allowance granted to swap router' }
  }
  if (valueEth > 0 && !tx.method) {
    return isFromMe
      ? { label: 'Sent ETH', detail: `${valueEth.toLocaleString('en-US', { maximumFractionDigits: 6 })} ETH` }
      : { label: 'Received ETH', detail: `${valueEth.toLocaleString('en-US', { maximumFractionDigits: 6 })} ETH` }
  }
  if (tx.method) {
    return { label: tx.method.charAt(0).toUpperCase() + tx.method.slice(1), detail: 'Contract interaction' }
  }
  return { label: isFromMe ? 'Sent transaction' : 'Contract interaction', detail: '' }
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'A valid address is required.' }, { status: 400 })
  }

  try {
    const res = await fetch(`${BLOCKSCOUT_BASE}/api/v2/addresses/${address}/transactions`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 15 },
    })
    if (!res.ok) {
      return NextResponse.json({ error: `Blockscout returned ${res.status}` }, { status: 502 })
    }
    const data = (await res.json()) as { items?: BlockscoutTx[] }

    const activity: ActivityEntry[] = (data.items || []).slice(0, 25).map((tx) => {
      const { label, detail } = describeTransaction(tx, address)
      return {
        hash: tx.hash,
        label,
        detail,
        status: tx.result === 'success' ? 'success' : tx.result === 'error' ? 'failed' : 'pending',
        timestamp: tx.timestamp,
        explorerUrl: `${BLOCKSCOUT_BASE}/tx/${tx.hash}`,
      }
    })

    return NextResponse.json({ activity })
  } catch (err) {
    console.error('[activity] Error fetching from Blockscout:', err)
    return NextResponse.json({ error: 'Could not reach the block explorer. Try again in a moment.' }, { status: 502 })
  }
}
