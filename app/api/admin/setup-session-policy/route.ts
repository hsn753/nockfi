import { NextResponse } from 'next/server'
import { SWAP_TOKENS, NATIVE_ETH_ADDRESS } from '@/lib/get-swap-quote'

export const dynamic = 'force-dynamic'

// One-time setup: creates the spend-limit policy that gets attached to a user's
// delegated wallet session signer. Confirmed policy engine semantics from Privy docs:
// default-deny (unmatched requests are denied), DENY takes precedence over ALLOW
// across rules, and conditions within one rule are AND'd. So each rule below is an
// independent, narrow "this exact case is fine" allowance — everything else is
// denied automatically, no explicit catch-all DENY rule needed.
//
// Rule 1 caps what can be sent to the 0x swap router (matches the router address our
// own quotes already return) at 0.05 ETH per transaction.
// Rule 2 allows zero-value approve() calls to the known swap tokens, needed to sell
// anything that isn't native ETH. Derived from the same SWAP_TOKENS the swap agent
// uses so this can't drift out of sync with what's actually swappable.
const ZEROX_ROUTER = '0x0000000000001fF3684f28c67538d4D072C22734'
const MAX_TX_VALUE_WEI = '50000000000000000' // 0.05 ETH
const SWAP_TOKEN_ADDRESSES = Object.values(SWAP_TOKENS)
  .map((t) => t.address)
  .filter((address) => address.toLowerCase() !== NATIVE_ETH_ADDRESS.toLowerCase())

export async function POST() {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID
  const appSecret = process.env.PRIVY_APP_SECRET
  if (!appId || !appSecret) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_PRIVY_APP_ID or PRIVY_APP_SECRET not configured' }, { status: 500 })
  }

  const body = {
    version: '1.0',
    name: 'Nock delegated swap session policy',
    chain_type: 'ethereum',
    rules: [
      {
        name: 'Allow 0x swap router up to 0.05 ETH per tx',
        method: 'eth_sendTransaction',
        action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'to', operator: 'eq', value: ZEROX_ROUTER },
          { field_source: 'ethereum_transaction', field: 'value', operator: 'lte', value: MAX_TX_VALUE_WEI },
        ],
      },
      {
        name: 'Allow zero-value approve() to swap tokens',
        method: 'eth_sendTransaction',
        action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'to', operator: 'in', value: SWAP_TOKEN_ADDRESSES },
          { field_source: 'ethereum_transaction', field: 'value', operator: 'eq', value: '0' },
        ],
      },
    ],
  }

  const res = await fetch('https://api.privy.io/v1/policies', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'privy-app-id': appId,
      Authorization: 'Basic ' + Buffer.from(`${appId}:${appSecret}`).toString('base64'),
    },
    body: JSON.stringify(body),
  })

  const data = await res.json()
  if (!res.ok) {
    return NextResponse.json({ error: 'Privy policy creation failed', detail: data }, { status: res.status })
  }

  return NextResponse.json({ policyId: data.id, policy: data })
}
