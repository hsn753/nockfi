import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { nockChain } from './chain'

// $NOCK token gating for the premium agents (Perps and Stock Token, per the
// one-pager; Yield and Swap stay free so onboarding is never blocked).
//
// Entirely env-driven and DORMANT BY DEFAULT: with NOCK_TOKEN_ADDRESS unset,
// every agent is free and nothing anywhere changes — so this ships safely before
// the token exists, and launch day is an env flip, not a deploy:
//   NOCK_TOKEN_ADDRESS   the official $NOCK ERC-20 on Robinhood Chain
//   NOCK_GATE_MIN_TOKENS minimum whole-token balance to unlock (default 1)
//
// The check is server-side in the Robin route (the only place actions are born),
// never client-side where it could be bypassed.

const rpcClient = createPublicClient({ chain: nockChain, transport: http(process.env.RPC_URL) })

export type NockGateStatus = {
  enabled: boolean
  holder: boolean
  balance: string
  requiredBalance: string
}

// Per-wallet cache so a burst of tool calls inside one conversation doesn't
// re-read the same balance; short TTL because an unlock (buying $NOCK) should
// take effect near-immediately.
const CACHE_TTL_MS = 30 * 1000
const cache = new Map<string, { status: NockGateStatus; expiresAt: number }>()

export async function getNockGateStatus(walletAddress: string | undefined): Promise<NockGateStatus> {
  const tokenAddress = process.env.NOCK_TOKEN_ADDRESS
  const required = process.env.NOCK_GATE_MIN_TOKENS || '1'

  if (!tokenAddress) {
    return { enabled: false, holder: true, balance: '0', requiredBalance: required }
  }
  if (!walletAddress) {
    return { enabled: true, holder: false, balance: '0', requiredBalance: required }
  }

  const key = walletAddress.toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() < hit.expiresAt) return hit.status

  try {
    const [raw, decimals] = await Promise.all([
      rpcClient.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddress as `0x${string}`] }),
      rpcClient.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }),
    ])
    const balance = formatUnits(raw, decimals)
    const status: NockGateStatus = {
      enabled: true,
      holder: parseFloat(balance) >= parseFloat(required),
      balance,
      requiredBalance: required,
    }
    cache.set(key, { status, expiresAt: Date.now() + CACHE_TTL_MS })
    return status
  } catch (err) {
    // Fail OPEN, deliberately: a flaky RPC must never lock paying holders out of
    // agents they own the token for. The gate is a product tier, not a security
    // boundary — all real protections (quotes, guards, spend limits) sit elsewhere.
    console.error('[nock-gate] Balance check failed, failing open:', err)
    return { enabled: true, holder: true, balance: 'unknown', requiredBalance: required }
  }
}

export function gateMessage(status: NockGateStatus, agentLabel: string): string {
  return `${agentLabel} is a premium agent unlocked by holding at least ${status.requiredBalance} $NOCK (this wallet holds ${status.balance}). Tell the user plainly: they can keep using the free agents (swaps and yield) without any token, and unlock ${agentLabel} by acquiring $NOCK. Do not propose the gated action.`
}
