// Perps execution adapter — the single chokepoint through which a real Lighter perps order
// would be placed. It is built and wired, but DISABLED by construction:
//
//   1. It refuses unless PERPS_ENABLED is true (off by default, legal-gated flag).
//   2. It refuses any restricted jurisdiction (geofence), independent of the flag.
//   3. It delegates the actual signing to a separate executor service (PERPS_EXECUTOR_URL),
//      because Lighter signs orders with a compiled EdDSA signer exposed through its Python/Go
//      SDK — not something the Next.js (Node) runtime does natively. With no executor URL
//      provisioned, there is nothing to execute against.
//
// So on today's deploy (flag off, no executor URL) this can never place an order — it returns
// a typed "not enabled / not provisioned" result that the caller turns into an honest message.
// Turning perps live is: legal sign-off → stand up the executor (Python, wrapping the official
// lighter-sdk, holding the app's Lighter API key) → set PERPS_EXECUTOR_URL + PERPS_ENABLED.

import { PERPS_ENABLED } from './feature-flags'
import type { PerpsGeo } from './geo-gate'

export type PerpsOrderRequest = {
  walletAddress: string
  symbol: string // e.g. 'ETH'
  side: 'long' | 'short'
  marginUsd: number
  leverage: number
  markPrice: number // reference from the preview, for the slippage guard
  maxSlippageBps?: number
}

export type PerpsOrderResult =
  | { ok: true; orderId: string; avgPrice: number; baseFilled: number; notionalUsd: number }
  | { ok: false; code: 'disabled' | 'geo_blocked' | 'not_provisioned' | 'over_limit' | 'invalid' | 'executor_error'; error: string }

// Hard safety cap on a single order's notional, independent of the venue's own limits — a
// belt-and-suspenders bound so a bad model/preview can't size an oversized position. Tunable
// via env once live; conservative default.
const MAX_NOTIONAL_USD = Number(process.env.PERPS_MAX_NOTIONAL_USD) || 5000

export async function executePerpsOrder(req: PerpsOrderRequest, geo: PerpsGeo): Promise<PerpsOrderResult> {
  // Gate 1 — the flag. Off by default; live perps is a deliberate, legal-gated switch.
  if (!PERPS_ENABLED) {
    return { ok: false, code: 'disabled', error: 'Perps execution is not enabled yet.' }
  }

  // Gate 2 — the geofence. Can never be overridden by the flag; restricted jurisdictions
  // (and any undetermined location) are refused here even if execution is otherwise live.
  if (!geo.allowed) {
    return { ok: false, code: 'geo_blocked', error: `Perps are not available in ${geo.country ?? 'your region'}.` }
  }

  // Gate 3 — sanity + spend bound. Never trust the caller's numbers blindly.
  if (!(req.marginUsd > 0) || !(req.leverage >= 1) || !(req.markPrice > 0) || (req.side !== 'long' && req.side !== 'short')) {
    return { ok: false, code: 'invalid', error: 'Invalid perps order parameters.' }
  }
  const notionalUsd = req.marginUsd * req.leverage
  if (notionalUsd > MAX_NOTIONAL_USD) {
    return { ok: false, code: 'over_limit', error: `Order notional $${notionalUsd.toLocaleString('en-US')} exceeds the $${MAX_NOTIONAL_USD.toLocaleString('en-US')} per-order limit.` }
  }

  // Gate 4 — provisioning. The executor is the Python service that actually signs against
  // Lighter. Absent it, there is no execution path (the honest state today).
  const executorUrl = process.env.PERPS_EXECUTOR_URL
  const executorSecret = process.env.PERPS_EXECUTOR_SECRET
  if (!executorUrl || !executorSecret) {
    return { ok: false, code: 'not_provisioned', error: 'Perps execution service is not provisioned.' }
  }

  // Delegate to the executor. It holds the Lighter API key, resolves the user's account,
  // signs, and submits the order — mirroring perps-poc/paper_perps.py but with the real
  // SignerClient in place of the paper fill engine.
  try {
    const res = await fetch(`${executorUrl.replace(/\/$/, '')}/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${executorSecret}` },
      body: JSON.stringify({
        wallet: req.walletAddress,
        symbol: req.symbol,
        side: req.side,
        margin_usd: req.marginUsd,
        leverage: req.leverage,
        mark_price: req.markPrice,
        max_slippage_bps: req.maxSlippageBps ?? 50,
        country: geo.country, // executor logs jurisdiction for the audit trail
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, code: 'executor_error', error: `Executor returned ${res.status}: ${body.slice(0, 200)}` }
    }
    const data = (await res.json()) as { orderId: string; avgPrice: number; baseFilled: number; notionalUsd: number }
    return { ok: true, ...data }
  } catch (err) {
    return { ok: false, code: 'executor_error', error: err instanceof Error ? err.message : 'Executor request failed.' }
  }
}
