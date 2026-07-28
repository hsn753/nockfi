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
  // PRIVATE routes only: the accepted deposit range, in sell-side units. Private quotes
  // carry no swapName/netAmountOut/supportsSignatures at all (verified live) — they're
  // CEX-mediated, so there's nothing to sign and the user deposits to an address instead.
  min?: number
  max?: number
}

// 'standard' = DEX/bridge routes: one signature on the sell chain, non-custodial, the
// default for funding/cash-out. 'private' = Houdini's anonymity tier: routed through
// CEXs, so it CANNOT be signed — the user transfers to a Houdini deposit address and the
// link between sender and recipient is broken on the way out. Private is only available
// where a CEX lists both sides: verified live as ETH<->ETH (Robinhood <-> Ethereum/Base,
// ~18 routes each way) but ZERO routes for anything USDG, since no CEX lists USDG.
export type HoudiniRouteType = 'standard' | 'private'

// Houdini returns ZERO private quotes for an amount below the tier's minimum — it does NOT
// return a quote carrying a `min` you could read. So "no private routes" is ambiguous
// between "this pair has no private tier at all" and "your amount is just too small", and
// telling a user the wrong one sends them away from a feature that would have worked.
// Resolve it by re-quoting once at a deliberately generous amount and reading the `min`
// off that. Cached per pair because the free tier allows only ~20 quotes/hour, so a user
// retrying a too-small amount must not burn the budget rediscovering the same number.
const privateMinCache = new Map<string, { min: number; at: number }>()
const PRIVATE_MIN_TTL_MS = 10 * 60 * 1000

async function probePrivateMin(fromId: string, toId: string, sellSymbol: string): Promise<number | null> {
  const key = `${fromId}->${toId}`
  const hit = privateMinCache.get(key)
  if (hit && Date.now() - hit.at < PRIVATE_MIN_TTL_MS) return hit.min
  // Generous enough to clear the minimum on any pair we support: ~$95 of ETH, or 100 units
  // of a stablecoin-denominated sell side.
  const probeAmount = sellSymbol.toUpperCase() === 'ETH' ? 0.05 : 100
  try {
    const data = await hfetch(`/quotes?amount=${probeAmount}&from=${fromId}&to=${toId}`)
    const priv = (data.quotes || []).find((q: any) => q?.type === 'private' && q.min != null)
    if (!priv) return null
    privateMinCache.set(key, { min: priv.min, at: Date.now() })
    return priv.min as number
  } catch {
    return null
  }
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
  routeType: HoudiniRouteType = 'standard',
): Promise<{ asset: HoudiniAsset; best: HoudiniRoute; all: HoudiniRoute[]; sign: HoudiniSignSide; robinhood: typeof ROBINHOOD_USDG | typeof ROBINHOOD_ETH }> {
  const asset = HOUDINI_ASSETS[assetKey]
  if (!asset) throw new Error(`Unsupported asset: ${assetKey}`)
  const rh = ROBINHOOD_ASSETS[robinhoodAsset]
  const fromId = direction === 'in' ? asset.tokenId : rh.tokenId
  const toId = direction === 'in' ? rh.tokenId : asset.tokenId
  const data = await hfetch(`/quotes?amount=${amount}&from=${fromId}&to=${toId}`)
  const wantPrivate = routeType === 'private'
  const raw: HoudiniRoute[] = (data.quotes || []).filter(
    (q: any) => q && q.quoteId && (q.netAmountOut ?? q.amountOut) != null,
  )
  let quotes: HoudiniRoute[] = raw.filter((q) => (wantPrivate ? q.type === 'private' : q.type !== 'private'))
  if (country) {
    quotes = quotes.filter((q) => !(q.restrictedCountries || []).map((c) => c.toUpperCase()).includes(country.toUpperCase()))
  }
  if (!quotes.length) {
    if (wantPrivate) {
      const sellSymbol = direction === 'in' ? asset.symbol : rh.symbol
      // Zero private routes usually means "below the minimum", not "unsupported pair" —
      // probe for the real minimum before blaming the pair (see probePrivateMin).
      const probedMin = await probePrivateMin(fromId, toId, sellSymbol)
      if (probedMin != null) {
        if (amount < probedMin) {
          // Pad the quoted floor slightly: the minimum drifts with price between quotes, so
          // echoing it exactly sends users straight back into the same failure.
          const suggested = Math.ceil(probedMin * 1.05 * 1e4) / 1e4
          throw new Error(`that's below the private-routing minimum for this route. Private sends need at least ~${suggested} ${sellSymbol} here (you asked for ${amount}). Try ~${suggested} ${sellSymbol} or more${asset.chain !== 'base' ? ', or send to Base instead, which has a much lower minimum' : ''}.`)
        }
        throw new Error('no private route is available for this amount right now.')
      }
      throw new Error(`private routing isn't available for this pair. Houdini's private tier routes through exchanges, and this asset isn't listed on them.`)
    }
    throw new Error('No route available for this amount right now.')
  }
  // A private quote's `min`/`max` is the accepted deposit range — an out-of-range amount
  // still returns a quote but would strand the deposit, so refuse it up front.
  if (wantPrivate) {
    const withRange = quotes.find((q) => q.min != null || q.max != null)
    const sellSymbol = direction === 'in' ? asset.symbol : rh.symbol
    if (withRange?.min != null && amount < withRange.min) {
      const suggested = Math.ceil(withRange.min * 1.05 * 1e4) / 1e4
      throw new Error(`that's below the private-routing minimum for this route. Private sends need at least ~${suggested} ${sellSymbol} here.`)
    }
    if (withRange?.max != null && amount > withRange.max) {
      throw new Error(`that's above the private-routing maximum for this route (max ~${withRange.max} ${sellSymbol}).`)
    }
  }
  const out = (q: HoudiniRoute) => q.netAmountOut ?? q.amountOut ?? 0
  // Private routes are never signature-based, so the signable preference only applies to
  // the standard tier (applying it there would empty the pool and fall through anyway).
  const signable = wantPrivate ? [] : quotes.filter((q) => q.type === 'dex' || q.supportsSignatures)
  const pool = signable.length ? signable : quotes
  // `eta`/`duration` are in SECONDS. Rank by output alone can pick a route that's orders of
  // magnitude slower for a marginal gain (seen live: a 600s route beat an 8s route by 0.02%
  // output) — restrict to routes finishing within 2 minutes when any exist, then pick the
  // best output among those; only fall back to the full (slow) pool if nothing qualifies.
  const FAST_ETA_CAP_SEC = 120
  const fastPool = pool.filter((q) => (q.eta ?? q.duration ?? Infinity) <= FAST_ETA_CAP_SEC)
  const rankPool = fastPool.length ? fastPool : pool
  const best = [...rankPool].sort((a, b) => out(b) - out(a))[0]
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
