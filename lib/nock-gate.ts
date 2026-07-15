import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { nockChain } from './chain'

// $NOCK token gating for the premium agents (Perps and Stock Token, per the
// one-pager; Yield and Swap stay free so onboarding is never blocked).
//
// DISABLED BY DEFAULT and flipped on with a SINGLE env var — no code deploy, no
// address to remember (it defaults to the official $NOCK below):
//   NOCK_GATE_ENABLED=true   ← the one switch. Unset/anything-else = off, all agents free.
//   NOCK_TOKEN_ADDRESS       optional override of the gate token (defaults to OFFICIAL_NOCK)
//   NOCK_GATE_MIN_TOKENS     minimum whole-token balance to unlock (default 1)
//
// The check is server-side in the Robin route (the only place actions are born),
// never client-side where it could be bypassed.

// The project's official $NOCK token — the gate defaults to this, so turning gating on is
// just NOCK_GATE_ENABLED=true (no need to paste the contract address anywhere).
const OFFICIAL_NOCK_ADDRESS = '0x1b27fF6e68A2fd6490543b17C996c109E64eb432'

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
  const enabled = process.env.NOCK_GATE_ENABLED === 'true'
  const tokenAddress = process.env.NOCK_TOKEN_ADDRESS || OFFICIAL_NOCK_ADDRESS
  const required = process.env.NOCK_GATE_MIN_TOKENS || '1'

  // Off by default: every agent is free until NOCK_GATE_ENABLED=true is set. Flipping it
  // on takes effect immediately (env change + restart), no code deploy.
  if (!enabled) {
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
