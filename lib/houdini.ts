// Houdini Swap — cross-chain funding INTO and cashing OUT OF Robinhood Chain.
//
// Two non-custodial, one-signature flows via Houdini Swap:
//   • IN  (fund):     an external asset on another chain → USDG on Robinhood.
//   • OUT (cash out): USDG on Robinhood → an external asset on another chain.
// v1 external asset is USDC on Ethereum/Base. Both directions use DEX/bridge routes
// (NOT Houdini's private/CEX tier — that tier can't touch USDG, since no CEX lists it,
// so it's unavailable for our assets anyway).
//
// Auth is a partner API key + partner code joined with a colon in the Authorization
// header ("<KEY>:<CODE>"). Both are server-only secrets — this module must never run
// client-side. Verified live (2026-07-22): Robinhood Chain = chainId 4663; USDG matches
// our on-chain USDG. Quotes/orders use Houdini's own token IDs (cached below).

const HOUDINI_BASE = 'https://api-partner.houdiniswap.com/v2'

// USDG on Robinhood Chain — the Robinhood side of every flow.
export const ROBINHOOD_USDG = {
  chainId: 4663,
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as `0x${string}`,
  decimals: 6,
  symbol: 'USDG',
  tokenId: '6a4686845de9c7c6e77d3f0c',
}

export type HoudiniAsset = {
  key: string
  chain: string // Houdini shortName
  chainId: number // EVM chain id of the external side
  symbol: string
  address: `0x${string}` // external token contract (for approvals when it's the sell side)
  decimals: number
  tokenId: string // Houdini token id
  label: string
}

// The external (non-Robinhood) asset in each flow. Used as the SOURCE for funding-in and
// the DESTINATION for cashing-out. USDC first (clean ~1:1 vs USDG, low slippage). Token
// ids verified live. Extend via GET /tokens?chain=<shortName>&address=<addr>.
// NOTE: native ETH ids are NOT discoverable through Houdini's listing API (native tokens
// are hidden from chain-filtered lists) — add ETH here once Houdini provides its token ids.
export const HOUDINI_ASSETS: Record<string, HoudiniAsset> = {
  'ethereum:USDC': {
    key: 'ethereum:USDC', chain: 'ethereum', chainId: 1, symbol: 'USDC',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6,
    tokenId: '6689b73ec90e45f3b3e51554', label: 'USDC on Ethereum',
  },
  'base:USDC': {
    key: 'base:USDC', chain: 'base', chainId: 8453, symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6,
    tokenId: '6689b757c90e45f3b3e51805', label: 'USDC on Base',
  },
}

export type HoudiniDirection = 'in' | 'out'

export function houdiniEnabled(): boolean {
  return process.env.HOUDINI_ENABLED === 'true' && !!process.env.HOUDINI_API_KEY && !!process.env.HOUDINI_CODE
}

function houdiniAuth(): string {
  const key = process.env.HOUDINI_API_KEY
  const code = process.env.HOUDINI_CODE
  if (!key || !code) throw new Error('HOUDINI_API_KEY / HOUDINI_CODE not configured')
  return `${key}:${code}`
}

async function hfetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${HOUDINI_BASE}${path}`, {
    ...init,
    headers: { Authorization: houdiniAuth(), 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = body?.message || body?.code || `Houdini API returned ${res.status}`
    const err = new Error(msg) as Error & { status?: number; body?: unknown }
    err.status = res.status
    err.body = body
    throw err
  }
  return body
}

export type HoudiniRoute = {
  quoteId: string
  swapName: string
  type: string
  amountIn: number
  amountOut: number
  netAmountOut: number
  feeUsd?: number
  gasUsd?: number
  eta?: number
  duration?: number
  requiresApproval?: boolean
  supportsSignatures?: boolean
  restrictedCountries?: string[]
}

// The token the user actually SIGNS with (the sell side), plus the chain they sign on.
export type HoudiniSignSide = { chainId: number; address: `0x${string}`; decimals: number; symbol: string }

// Quote a flow. `direction` picks which side is USDG:
//   in  → from external asset, to USDG (sign on the external chain).
//   out → from USDG, to external asset (sign on Robinhood Chain).
// `amount` is in human units of the SELL side. Returns the best signable DEX route.
export async function getHoudiniQuote(
  assetKey: string,
  amount: number,
  direction: HoudiniDirection,
  country?: string,
): Promise<{ asset: HoudiniAsset; best: HoudiniRoute; all: HoudiniRoute[]; sign: HoudiniSignSide }> {
  const asset = HOUDINI_ASSETS[assetKey]
  if (!asset) throw new Error(`Unsupported asset: ${assetKey}`)
  const fromId = direction === 'in' ? asset.tokenId : ROBINHOOD_USDG.tokenId
  const toId = direction === 'in' ? ROBINHOOD_USDG.tokenId : asset.tokenId
  const data = await hfetch(`/quotes?amount=${amount}&from=${fromId}&to=${toId}`)
  let quotes: HoudiniRoute[] = (data.quotes || []).filter(
    (q: any) => q && q.quoteId && q.type !== 'private' && (q.netAmountOut ?? q.amountOut) != null,
  )
  if (country) {
    quotes = quotes.filter((q) => !(q.restrictedCountries || []).map((c) => c.toUpperCase()).includes(country.toUpperCase()))
  }
  if (!quotes.length) throw new Error('No route available for this amount right now.')
  const out = (q: HoudiniRoute) => q.netAmountOut ?? q.amountOut ?? 0
  const signable = quotes.filter((q) => q.type === 'dex' || q.supportsSignatures)
  const pool = signable.length ? signable : quotes
  const best = [...pool].sort((a, b) => out(b) - out(a))[0]
  const sign: HoudiniSignSide =
    direction === 'in'
      ? { chainId: asset.chainId, address: asset.address, decimals: asset.decimals, symbol: asset.symbol }
      : { chainId: ROBINHOOD_USDG.chainId, address: ROBINHOOD_USDG.address, decimals: ROBINHOOD_USDG.decimals, symbol: ROBINHOOD_USDG.symbol }
  return { asset, best, all: quotes, sign }
}

export type HoudiniOrder = {
  houdiniId: string
  status: number
  expires?: string
  inAmount?: number
  outAmount?: number
  isDex?: boolean
  metadata?: {
    to: `0x${string}`
    data: `0x${string}`
    value: string
    gasLimit?: string
    maxFeePerGas?: string
    maxPriorityFeePerGas?: string
    router?: string
    routing?: string
    deadline?: number
    slippage?: number
  }
  depositAddress?: string
}

// addressFrom = the user's wallet on the SELL chain (signer); addressTo = where the bought
// asset is delivered (same EVM address). Returns the sign-chain tx (DEX) or deposit address.
export async function createHoudiniExchange(
  quoteId: string,
  addressFrom: string,
  addressTo: string,
): Promise<HoudiniOrder> {
  return (await hfetch('/exchanges', {
    method: 'POST',
    body: JSON.stringify({ quoteId, addressTo, addressFrom }),
  })) as HoudiniOrder
}

export async function getHoudiniOrder(houdiniId: string): Promise<HoudiniOrder> {
  return (await hfetch(`/orders/${encodeURIComponent(houdiniId)}`)) as HoudiniOrder
}

// Map Houdini's numeric status to a human label + terminal flags. Provisional (status 0 =
// awaiting/processing observed live); unknown codes read as "processing" so completion is
// never falsely claimed. Negative = error.
export function houdiniStatusLabel(status: number): { label: string; done: boolean; failed: boolean } {
  switch (status) {
    case 0: return { label: 'Waiting for your deposit', done: false, failed: false }
    case 1: return { label: 'Confirming on-chain', done: false, failed: false }
    case 2: return { label: 'Exchanging', done: false, failed: false }
    case 3: return { label: 'Sending to your wallet', done: false, failed: false }
    case 4:
    case 5: return { label: 'Completed', done: true, failed: false }
    default: return status < 0 ? { label: 'Failed', done: false, failed: true } : { label: 'Processing', done: false, failed: false }
  }
}
