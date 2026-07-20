// Thin client for the RH Lighter instance's public REST API — the same venue the perps
// executor trades on (see lib/get-perps-data.ts, lib/lighter-execute.ts). Called directly
// from the browser: Lighter sends `access-control-allow-origin: *` on every endpoint used
// here (confirmed live), so there's no need to proxy these through our own server, and
// doing so would defeat the point — the browser is the one signing and submitting, and
// letting the browser's own IP hit Lighter directly means Lighter's own geoblock enforces
// jurisdiction exactly like lib/geo-gate.ts does, with no workaround needed.
export const LIGHTER_BASE = 'https://api.rh.lighter.xyz'
export const LIGHTER_CHAIN_ID = 466324

export async function lookupLighterAccount(l1Address: string): Promise<{ accountIndex: number } | null> {
  try {
    const res = await fetch(`${LIGHTER_BASE}/api/v1/accountsByL1Address?l1_address=${l1Address}`)
    if (!res.ok) return null
    const data = (await res.json()) as { sub_accounts?: { index: number }[] }
    const first = data.sub_accounts?.[0]
    return first ? { accountIndex: first.index } : null
  } catch {
    return null
  }
}

export async function listLighterApiKeys(accountIndex: number): Promise<{ apiKeyIndex: number; publicKey: string }[]> {
  const res = await fetch(`${LIGHTER_BASE}/api/v1/apikeys?account_index=${accountIndex}`)
  if (!res.ok) throw new Error(`apikeys lookup failed: HTTP ${res.status}`)
  const data = (await res.json()) as { api_keys?: { api_key_index: number; public_key: string }[] }
  return (data.api_keys ?? []).map((k) => ({ apiKeyIndex: k.api_key_index, publicKey: k.public_key }))
}

// First unused index starting at 1 — index 0 is left alone since a user who's ever used
// Lighter's own web app is likely to already have a key registered there.
export function pickFreeApiKeyIndex(existing: { apiKeyIndex: number }[]): number {
  const used = new Set(existing.map((k) => k.apiKeyIndex))
  for (let i = 1; i <= 254; i++) {
    if (!used.has(i)) return i
  }
  throw new Error('No free Lighter API key index available on this account.')
}

// Falls back to 0 on any error — a brand-new, not-yet-registered api key index has no
// nonce history yet, and Lighter's own nextNonce endpoint may not have an entry for it.
export async function getLighterNextNonce(accountIndex: number, apiKeyIndex: number): Promise<number> {
  try {
    const res = await fetch(`${LIGHTER_BASE}/api/v1/nextNonce?account_index=${accountIndex}&api_key_index=${apiKeyIndex}`)
    if (!res.ok) return 0
    const data = (await res.json()) as { code: number; nonce?: number }
    return data.code === 200 && typeof data.nonce === 'number' ? data.nonce : 0
  } catch {
    return 0
  }
}

export type LighterMarket = {
  marketId: number
  sizeDecimals: number
  priceDecimals: number
  minBaseAmount: number
  markPrice: number
}

// Resolve a perp market's on-chain params (id + decimals + current mark) from the RH
// order book. Needed to size an order and cap its price. Symbol match is case-insensitive.
export async function resolveLighterMarket(symbol: string): Promise<LighterMarket> {
  const res = await fetch(`${LIGHTER_BASE}/api/v1/orderBookDetails`)
  if (!res.ok) throw new Error(`orderBookDetails failed: HTTP ${res.status}`)
  const data = (await res.json()) as {
    order_book_details?: Array<{
      symbol: string
      market_id: number
      market_type: string
      supported_size_decimals: number
      supported_price_decimals: number
      min_base_amount: string
      mark_price: string
    }>
  }
  const m = (data.order_book_details ?? []).find(
    (x) => x.symbol.toUpperCase() === symbol.toUpperCase() && x.market_type === 'perp',
  )
  if (!m) throw new Error(`No perp market found for ${symbol}.`)
  return {
    marketId: m.market_id,
    sizeDecimals: m.supported_size_decimals,
    priceDecimals: m.supported_price_decimals,
    minBaseAmount: parseFloat(m.min_base_amount),
    markPrice: parseFloat(m.mark_price),
  }
}

export type LighterPosition = {
  symbol: string
  signedSize: number // + long, - short, 0 flat
  avgEntryPrice: number
  positionValue: number
  unrealizedPnl: number
}

// Read the account's current position in one market (for confirming a fill after an
// order). Returns null if flat or on any error.
export async function getLighterPosition(accountIndex: number, marketId: number): Promise<LighterPosition | null> {
  try {
    const res = await fetch(`${LIGHTER_BASE}/api/v1/account?by=index&value=${accountIndex}`)
    if (!res.ok) return null
    const data = (await res.json()) as {
      accounts?: Array<{ positions?: Array<Record<string, unknown>> }>
    }
    const positions = data.accounts?.[0]?.positions ?? []
    const p = positions.find((x) => Number(x.market_id) === marketId)
    if (!p) return null
    const size = Math.abs(parseFloat(String(p.position ?? '0')))
    if (size === 0) return null
    const sign = Number(p.sign) === 1 ? 1 : -1
    return {
      symbol: String(p.symbol ?? ''),
      signedSize: sign * size,
      avgEntryPrice: parseFloat(String(p.avg_entry_price ?? '0')),
      positionValue: parseFloat(String(p.position_value ?? '0')),
      unrealizedPnl: parseFloat(String(p.unrealized_pnl ?? '0')),
    }
  } catch {
    return null
  }
}

export type SubmitTxResult = { ok: true } | { ok: false; code: number; message: string }

// Wire format verified live this session: POST, form-urlencoded, tx_type + tx_info.
export async function submitLighterTx(txType: number, txInfoJson: string): Promise<SubmitTxResult> {
  const body = new URLSearchParams({ tx_type: String(txType), tx_info: txInfoJson })
  const res = await fetch(`${LIGHTER_BASE}/api/v1/sendTx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string }
  if (res.ok && data.code === 200) return { ok: true }
  return { ok: false, code: data.code ?? res.status, message: data.message || `HTTP ${res.status}` }
}
