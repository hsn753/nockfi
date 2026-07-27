import { erc20Abi } from 'viem'
import { getReferencePrices } from './get-prices'
import { getReadClient } from './rpc'
import { getTokenPriceByAddress } from './get-trending-tokens'
import { findStockToken } from './get-stock-tokens'
import { getStockBorrowPositions } from './get-stock-collateral'
import { SWAP_TOKENS } from './get-swap-quote'
import { executeSellToUsdg, buyWithUsdg } from './strategy-execution'
import {
  getAllEnabledConditions,
  markConditionTriggered,
  markConditionReset,
  recordConditionEvent,
  disableCondition,
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

// Decimals for the sell token — from the known-token map when possible, else read on-chain
// (stock tokens are 18, but never assume: a wrong decimals would misprice the whole sell).
async function resolveDecimals(symbol: string | null, tokenAddress: string): Promise<number> {
  const known = symbol ? SWAP_TOKENS[symbol.toUpperCase()] : undefined
  if (known) return known.decimals
  try {
    const d = (await getReadClient().readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' })) as number
    return Number(d)
  } catch {
    return 18
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
        if (cond.action === 'sell_to_usdg' && cond.tokenAddress) {
          // Execute the sell (allowance model) instead of only alerting. A stop-loss is
          // one-shot — disable the condition after a successful sell so it never re-fires
          // on a token the user no longer holds.
          const decimals = await resolveDecimals(cond.symbol, cond.tokenAddress)
          const res = await executeSellToUsdg(cond.address, cond.tokenAddress, decimals, cond.symbol ?? 'token')
          const msg =
            res.status === 'executed'
              ? `Stop-loss hit — sold ${Number(res.soldAmount).toLocaleString()} ${cond.symbol ?? ''} for ${Number(res.boughtAmount).toFixed(2)} USDG (${cond.symbol} was ${cond.comparator} $${Number(cond.threshold)}).`
              : res.status === 'not_authorized'
                ? `${cond.symbol} ${cond.comparator} $${Number(cond.threshold)} — but I'm not approved to sell it. Re-approve the automation address for ${cond.symbol} to arm this.`
                : `Tried to sell ${cond.symbol} on your stop-loss but it didn't complete: ${res.message}`
          await recordConditionEvent(cond.walletId, cond.id, msg, observed)
          if (res.status === 'executed') await disableCondition(cond.id)
        } else if (cond.action === 'buy_with_usdg' && cond.tokenAddress) {
          // Conditional BUY — spend a fixed USDG amount on the token when the trigger hits.
          // One-shot like the sell. USDG is ERC20 (approvable), so this works even to buy
          // native ETH (the target is received, not pulled).
          const decimals = await resolveDecimals(cond.symbol, cond.tokenAddress)
          const usd = Number(cond.actionAmountUsd ?? 0)
          const res = await buyWithUsdg(cond.address, { address: cond.tokenAddress, decimals, symbol: cond.symbol ?? 'token' }, usd)
          const msg =
            res.status === 'executed'
              ? `Bought ${Number(res.boughtAmount).toLocaleString()} ${cond.symbol ?? ''} with ${usd.toFixed(2)} USDG (${cond.symbol} was ${cond.comparator} $${Number(cond.threshold)}).`
              : res.status === 'not_authorized'
                ? `${cond.symbol} ${cond.comparator} $${Number(cond.threshold)} — but I'm not approved to spend your USDG. Re-approve USDG to arm this buy.`
                : `Tried to buy ${cond.symbol} but it didn't complete: ${res.message}`
          await recordConditionEvent(cond.walletId, cond.id, msg, observed)
          if (res.status === 'executed') await disableCondition(cond.id)
        } else {
          await recordConditionEvent(cond.walletId, cond.id, alertMessage(cond, observed), observed)
        }
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
