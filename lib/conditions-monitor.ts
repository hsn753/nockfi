import { getReferencePrices } from './get-prices'
import { getTokenPriceByAddress } from './get-trending-tokens'
import { findStockToken } from './get-stock-tokens'
import { getStockBorrowPositions } from './get-stock-collateral'
import {
  getAllEnabledConditions,
  markConditionTriggered,
  markConditionReset,
  recordConditionEvent,
  type ConditionRow,
} from './db/conditions'

// The monitor engine — evaluates every enabled user condition against live data and fires
// an alert (records an event the client surfaces as an attention item) when a condition
// crosses into true. Edge-triggered: fires once per crossing, resets when it goes false, so
// a condition that stays true doesn't spam. v1 action is 'alert' only; auto-execute actions
// (sell-to-USDG, yield move) plug in here once the session-signer path is live.

export type ConditionSweepSummary = { checked: number; fired: number; reset: number; errored: number }

// Resolve the current observed value for a condition, or null if it can't be priced now.
async function observe(cond: ConditionRow, ctx: { address: string; prices: Record<string, number> }): Promise<number | null> {
  try {
    if (cond.kind === 'loan_ltv') {
      const loans = await getStockBorrowPositions(ctx.address)
      const relevant = cond.symbol
        ? loans.filter((l) => l.stockSymbol.toLowerCase() === cond.symbol!.toLowerCase())
        : loans
      if (relevant.length === 0) return null
      return Math.max(...relevant.map((l) => l.ltvUtilizationPct))
    }
    // token_price
    const sym = (cond.symbol ?? '').toUpperCase()
    if (ctx.prices[sym] != null) return ctx.prices[sym]
    if (cond.tokenAddress) {
      const t = await getTokenPriceByAddress(cond.tokenAddress)
      if (t?.priceUsd != null) return t.priceUsd
    }
    if (cond.symbol) {
      const stock = await findStockToken(cond.symbol)
      if (stock?.priceUsd != null) return stock.priceUsd
    }
    return null
  } catch (err) {
    console.error('[conditions-monitor] observe failed for', cond.id, err)
    return null
  }
}

function isTrue(cond: ConditionRow, observed: number): boolean {
  const threshold = Number(cond.threshold)
  return cond.comparator === 'below' ? observed < threshold : observed > threshold
}

function alertMessage(cond: ConditionRow, observed: number): string {
  const threshold = Number(cond.threshold)
  if (cond.kind === 'loan_ltv') {
    const which = cond.symbol ? `${cond.symbol} loan` : 'A loan'
    return `${which} is at ${observed.toFixed(0)}% of its liquidation ceiling (your alert was ${cond.comparator} ${threshold}%). Consider repaying or adding collateral.`
  }
  const sym = cond.symbol ?? 'Asset'
  return `${sym} is ${cond.comparator === 'below' ? 'down to' : 'up to'} $${observed < 1 ? observed.toPrecision(4) : observed.toFixed(2)} (your alert was ${cond.comparator} $${threshold}).`
}

export async function runConditionSweep(): Promise<ConditionSweepSummary> {
  const summary: ConditionSweepSummary = { checked: 0, fired: 0, reset: 0, errored: 0 }
  const [conditions, prices] = await Promise.all([getAllEnabledConditions(), getReferencePrices()])

  for (const cond of conditions) {
    summary.checked++
    try {
      const observed = await observe(cond, { address: cond.address, prices })
      if (observed == null) continue // can't price it right now — skip, try next sweep
      const currentlyTrue = isTrue(cond, observed)
      const alreadyFired = cond.lastTriggeredAt != null

      if (currentlyTrue && !alreadyFired) {
        await recordConditionEvent(cond.walletId, cond.id, alertMessage(cond, observed), observed)
        await markConditionTriggered(cond.id, observed)
        summary.fired++
      } else if (!currentlyTrue && alreadyFired) {
        await markConditionReset(cond.id, observed)
        summary.reset++
      }
    } catch (err) {
      console.error('[conditions-monitor] sweep failed for', cond.id, err)
      summary.errored++
    }
  }
  return summary
}
