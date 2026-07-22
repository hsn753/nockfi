// Houdini Swap — cross-chain funding into Robinhood Chain.
//
// Lets a NockFi user fund their wallet with USDG on Robinhood Chain starting from an
// asset on another chain (v1: USDC on Ethereum or Base), replacing the old
// Arbitrum-bridge deep-link with an in-app, one-signature flow. Houdini earns affiliate
// commissions from its exchange partners and shares a markup with us (configured on the
// partner account — supported routes already carry it).
//
// Auth is a partner API key + partner code, joined with a colon in the Authorization
// header ("<KEY>:<CODE>"). Both are server-only secrets — this module must never run
// client-side, and the values must never reach the browser.
//
// Verified live against the real API (2026-07-22): Robinhood Chain is chainId 4663 /
// shortName "Robinhood"; USDG there matches our on-chain USDG exactly. Quotes/orders use
// Houdini's own token IDs (not symbols/addresses), cached below.

const HOUDINI_BASE = 'https://api-partner.houdiniswap.com/v2'

// Destination: USDG on Robinhood Chain (Houdini token id).
const DEST_USDG_ROBINHOOD = '6a4686845de9c7c6e77d3f0c'

export type HoudiniSource = {
  key: string
  chain: string // Houdini shortName
  chainId: number // EVM chain id (source chain the user signs on)
  symbol: string
  address: `0x${string}` // source token contract (for the approval before the bridge tx)
  decimals: number
  tokenId: string // Houdini token id (for /quotes)
  label: string
}

// Supported funding sources → USDG on Robinhood. USDC first (clean ~1:1 stablecoin
// funding, low slippage). Token ids resolved live from Houdini's /tokens and cached here
// to avoid per-request lookups (and its 5-exchange/min free-tier rate limit). Extend by
// adding entries — resolve a token id via GET /tokens?chain=<shortName>&address=<addr>.
export const HOUDINI_SOURCES: Record<string, HoudiniSource> = {
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
    headers: {
      Authorization: houdiniAuth(),
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    // Surface the API's own message (e.g. rate-limit, validation) rather than a generic error.
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
  type: string // 'dex' | 'cex' | ...
  amountIn: number
  amountOut: number
  netAmountOut: number
  feeUsd?: number
  gasUsd?: number
  eta?: number
  duration?: number
  requiresApproval?: boolean
  supportsSignatures?: boolean
  markupSupported?: boolean
  apiMarkupValue?: number
  restrictedCountries?: string[]
}

// Quote a funding route. Returns the best signable route (one-signature DEX/bridge flow
// preferred) plus the full list. `amount` is in human units of the source token.
export async function getHoudiniQuote(
  sourceKey: string,
  amount: number,
  country?: string,
): Promise<{ source: HoudiniSource; best: HoudiniRoute; all: HoudiniRoute[] }> {
  const source = HOUDINI_SOURCES[sourceKey]
  if (!source) throw new Error(`Unsupported funding source: ${sourceKey}`)
  const data = await hfetch(`/quotes?amount=${amount}&from=${source.tokenId}&to=${DEST_USDG_ROBINHOOD}`)
  let quotes: HoudiniRoute[] = (data.quotes || []).filter(
    (q: any) => q && q.quoteId && (q.netAmountOut ?? q.amountOut) != null,
  )
  // Honor each route's own geo restriction (fail-closed): drop routes restricted in the
  // user's country when we know it.
  if (country) {
    quotes = quotes.filter((q) => !(q.restrictedCountries || []).map((c) => c.toUpperCase()).includes(country.toUpperCase()))
  }
  if (!quotes.length) throw new Error('No route available for this amount right now.')
  const out = (q: HoudiniRoute) => q.netAmountOut ?? q.amountOut ?? 0
  // Prefer routes we can settle with a single on-chain signature (DEX/bridge) over
  // deposit-address (CEX) routes; among those pick the best net output for the user.
  const signable = quotes.filter((q) => q.type === 'dex' || q.supportsSignatures)
  const pool = signable.length ? signable : quotes
  const best = [...pool].sort((a, b) => out(b) - out(a))[0]
  return { source, best, all: quotes }
}

export type HoudiniOrder = {
  houdiniId: string
  status: number
  expires?: string
  inAmount?: number
  outAmount?: number
  isDex?: boolean
  // For DEX/bridge routes: the ready-to-sign transaction on the SOURCE chain.
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
  // For CEX/private routes: the address to send the source asset to.
  depositAddress?: string
}

// Create an exchange from a quote. addressFrom = the user's wallet on the source chain
// (signer), addressTo = where USDG is delivered on Robinhood (same EVM address). Returns
// the order incl. the source-chain tx to sign (DEX) or a deposit address (CEX).
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

// Map Houdini's numeric status to a human label + terminal flags. Provisional mapping
// (status 0 = awaiting deposit/processing observed live); unknown codes read as
// "processing" so we never falsely claim completion. Negative codes = error.
export function houdiniStatusLabel(status: number): { label: string; done: boolean; failed: boolean } {
  switch (status) {
    case 0:
      return { label: 'Waiting for your deposit', done: false, failed: false }
    case 1:
      return { label: 'Confirming on-chain', done: false, failed: false }
    case 2:
      return { label: 'Exchanging', done: false, failed: false }
    case 3:
      return { label: 'Sending to your wallet', done: false, failed: false }
    case 4:
    case 5:
      return { label: 'Completed', done: true, failed: false }
    default:
      return status < 0
        ? { label: 'Failed', done: false, failed: true }
        : { label: 'Processing', done: false, failed: false }
  }
}
