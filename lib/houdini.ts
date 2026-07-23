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

// USDG on Robinhood Chain — the default Robinhood side (fund your USDG wallet).
export const ROBINHOOD_USDG = {
  chainId: 4663,
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as `0x${string}`,
  decimals: 6,
  symbol: 'USDG',
  tokenId: '6a4686845de9c7c6e77d3f0c',
}

// Native ETH on Robinhood Chain — the OTHER possible Robinhood side, for a direct
// ETH<->ETH bridge that never touches USDG (e.g. "bridge my ETH to Ethereum, keep it as
// ETH"). Distinct product from funding/cashing-out the USDG wallet. Verified live:
// Houdini offers DEX routes both ways against ETH@Ethereum and ETH@Base.
export const ROBINHOOD_ETH = {
  chainId: 4663,
  address: null as `0x${string}` | null,
  decimals: 18,
  symbol: 'ETH',
  tokenId: '6a461601a5a43628a07b3b17',
}

export type RobinhoodAssetKey = 'USDG' | 'ETH'
export const ROBINHOOD_ASSETS: Record<RobinhoodAssetKey, typeof ROBINHOOD_USDG | typeof ROBINHOOD_ETH> = {
  USDG: ROBINHOOD_USDG,
  ETH: ROBINHOOD_ETH,
}

export type HoudiniAsset = {
  key: string
  chain: string // Houdini shortName
  chainId: number // EVM chain id of the external side
  symbol: string
  address: `0x${string}` | null // external token contract; null = native asset (e.g. ETH — no ERC20 to approve)
  decimals: number
  tokenId: string // Houdini token id
  label: string
}

// The external (non-Robinhood) asset in each flow. Used as the SOURCE for funding-in and
// the DESTINATION for cashing-out. Token ids verified live. Extend via
// GET /tokens?chain=<shortName>&address=<addr> for ERC20s; native coins (address=null, e.g.
// ETH) aren't returned by that address-filtered lookup — they only surface via
// GET /tokens?chain=<shortName>&search=<symbol> (paginated; the exact-symbol match has
// address:null and its own token id).
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
  'ethereum:ETH': {
    key: 'ethereum:ETH', chain: 'ethereum', chainId: 1, symbol: 'ETH',
    address: null, decimals: 18,
    tokenId: '6689b73ec90e45f3b3e51566', label: 'ETH on Ethereum',
  },
  'base:ETH': {
    key: 'base:ETH', chain: 'base', chainId: 8453, symbol: 'ETH',
    address: null, decimals: 18,
    tokenId: '6689b73ec90e45f3b3e51590', label: 'ETH on Base',
  },
}

export type HoudiniDirection = 'in' | 'out'

// USDG/USDC amounts round sensibly at 2 decimals; ETH amounts (often < 0.01) need more
// precision or they'd display as a misleading "0.00".
export function fmtHoudiniAmount(value: number, symbol: string): string {
  return symbol === 'ETH' ? value.toFixed(5) : value.toFixed(2)
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
  amountOutUsd?: number // dollar value of amountOut — NOT 1:1 with amountOut for non-stablecoin routes (e.g. ETH)
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
// address is null for a native-coin sell (e.g. ETH) — there's no ERC20 to approve; the
// amount is sent as tx value instead.
export type HoudiniSignSide = { chainId: number; address: `0x${string}` | null; decimals: number; symbol: string }

// Quote a flow. `direction` picks which side is the Robinhood asset (`robinhoodAsset`,
// default USDG — the "fund/cash-out your USDG wallet" product):
//   in  → from external asset, to the Robinhood asset (sign on the external chain).
//   out → from the Robinhood asset, to external asset (sign on Robinhood Chain).
// Passing robinhoodAsset:'ETH' gives the OTHER product — a direct ETH<->ETH bridge that
// never touches USDG. `amount` is in human units of the SELL side. Returns the best
// signable DEX route.
export async function getHoudiniQuote(
  assetKey: string,
  amount: number,
  direction: HoudiniDirection,
  country?: string,
  robinhoodAsset: RobinhoodAssetKey = 'USDG',
): Promise<{ asset: HoudiniAsset; best: HoudiniRoute; all: HoudiniRoute[]; sign: HoudiniSignSide; robinhood: typeof ROBINHOOD_USDG | typeof ROBINHOOD_ETH }> {
  const asset = HOUDINI_ASSETS[assetKey]
  if (!asset) throw new Error(`Unsupported asset: ${assetKey}`)
  const rh = ROBINHOOD_ASSETS[robinhoodAsset]
  const fromId = direction === 'in' ? asset.tokenId : rh.tokenId
  const toId = direction === 'in' ? rh.tokenId : asset.tokenId
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
      : { chainId: rh.chainId, address: rh.address, decimals: rh.decimals, symbol: rh.symbol }
  return { asset, best, all: quotes, sign, robinhood: rh }
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
