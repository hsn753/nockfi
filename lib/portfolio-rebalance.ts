import { fetchWalletBalances } from './get-balances'
import { sellUsdWorthToUsdg, buyWithUsdg, type TokenRef } from './strategy-execution'
import { withAutomationLock } from './automation-lock'
import {
  getEnabledRebalanceWallets,
  touchRebalanceCheckedAt,
  recordRebalanceEvent,
  type RebalanceTarget,
} from './db/portfolio-rebalance'

// Target-allocation portfolio rebalancing. The user sets a target mix of NON-USDG assets
// (e.g. 40% ETH); USDG is the implicit balancing bucket. Each sweep computes the current
// allocation across {USDG + targeted assets}, and when an asset drifts more than the
// threshold from its target, it trims the over-weight (sell to USDG) or tops up the
// under-weight (buy from USDG) via the allowance-model swaps. All within the basket the
// user defined — untargeted holdings are ignored.

export function portfolioRebalanceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PORTFOLIO_REBALANCE_ENABLED === 'true' && !!process.env.YIELD_AUTOMATION_PRIVATE_KEY
}

// Don't churn gas on tiny corrections.
const MIN_REBALANCE_USD = 1

export type RebalanceSweepSummary = { checked: number; rebalanced: number; skipped: number; failed: number }

const EMPTY_REBALANCE_SUMMARY: RebalanceSweepSummary = { checked: 0, rebalanced: 0, skipped: 0, failed: 0 }

// Serialized against every other sweep (any type, any pm2 worker) via withAutomationLock —
// see its comment for why an in-process-only lock isn't enough on production's 2 workers.
export async function runPortfolioRebalanceSweep(): Promise<RebalanceSweepSummary> {
  const result = await withAutomationLock('portfolio-rebalance', runPortfolioRebalanceSweepInner)
  return result ?? EMPTY_REBALANCE_SUMMARY
}

async function runPortfolioRebalanceSweepInner(): Promise<RebalanceSweepSummary> {
  const summary: RebalanceSweepSummary = { ...EMPTY_REBALANCE_SUMMARY }
  const wallets = await getEnabledRebalanceWallets()

  for (const w of wallets) {
    summary.checked++
    try {
      const acted = await rebalanceWallet(w.walletId, w.address, w.targets, Number(w.driftThresholdPct))
      if (acted === 'rebalanced') summary.rebalanced++
      else if (acted === 'failed') summary.failed++
      else summary.skipped++
      await touchRebalanceCheckedAt(w.walletId)
    } catch (err) {
      console.error(`[portfolio-rebalance] Sweep failed for ${w.address}:`, err)
      summary.failed++
    }
  }
  return summary
}

async function rebalanceWallet(
  walletId: string,
  address: string,
  targets: RebalanceTarget[],
  driftThresholdPct: number,
): Promise<'rebalanced' | 'skipped' | 'failed'> {
  const balances = await fetchWalletBalances(address as `0x${string}`)
  const bySymbol = new Map(balances.map((b) => [b.symbol.toUpperCase(), b]))
  const usdgUsd = bySymbol.get('USDG')?.usdValue ?? 0

  // Basket total = USDG + every targeted asset's current value.
  let total = usdgUsd
  const rows = targets.map((t) => {
    const b = bySymbol.get(t.symbol.toUpperCase())
    const currentUsd = b?.usdValue ?? 0
    const amountFloat = b ? parseFloat(b.amount.replace(/,/g, '')) : 0
    const priceUsd = amountFloat > 0 && currentUsd > 0 ? currentUsd / amountFloat : 0
    total += currentUsd
    return { t, currentUsd, priceUsd }
  })
  if (total <= 0) return 'skipped'

  // Compute per-asset dollar deltas against the target, split into trims (sell) and top-ups
  // (buy). Sells run FIRST so the USDG they raise is available for the buys.
  const trims: { row: (typeof rows)[number]; usd: number }[] = []
  const topUps: { row: (typeof rows)[number]; usd: number }[] = []
  for (const row of rows) {
    const currentPct = (row.currentUsd / total) * 100
    const driftPct = currentPct - row.t.targetPct
    if (Math.abs(driftPct) < driftThresholdPct) continue
    const deltaUsd = (driftPct / 100) * total
    if (deltaUsd > MIN_REBALANCE_USD) trims.push({ row, usd: deltaUsd })
    else if (-deltaUsd > MIN_REBALANCE_USD) topUps.push({ row, usd: -deltaUsd })
  }
  if (trims.length === 0 && topUps.length === 0) return 'skipped'

  let anyExecuted = false
  let anyFailed = false

  for (const { row, usd } of trims) {
    const token: TokenRef = { address: row.t.address, decimals: row.t.decimals, symbol: row.t.symbol }
    const res = await sellUsdWorthToUsdg(address, token, usd, row.priceUsd)
    await recordRebalanceEvent({
      walletId, fromSymbol: row.t.symbol, toSymbol: 'USDG', usdAmount: Math.round(usd * 100) / 100,
      status: res.status === 'executed' ? 'executed' : res.status === 'not_authorized' ? 'not_authorized' : 'failed',
      errorMessage: res.status === 'executed' ? undefined : res.message,
    })
    if (res.status === 'executed') anyExecuted = true
    else anyFailed = true
  }

  for (const { row, usd } of topUps) {
    if (usdgUsd < MIN_REBALANCE_USD) {
      await recordRebalanceEvent({ walletId, fromSymbol: 'USDG', toSymbol: row.t.symbol, usdAmount: Math.round(usd * 100) / 100, status: 'skipped', errorMessage: 'Not enough USDG on hand to top this up.' })
      continue
    }
    const token: TokenRef = { address: row.t.address, decimals: row.t.decimals, symbol: row.t.symbol }
    const res = await buyWithUsdg(address, token, Math.min(usd, usdgUsd))
    await recordRebalanceEvent({
      walletId, fromSymbol: 'USDG', toSymbol: row.t.symbol, usdAmount: Math.round(Math.min(usd, usdgUsd) * 100) / 100,
      status: res.status === 'executed' ? 'executed' : res.status === 'not_authorized' ? 'not_authorized' : 'failed',
      errorMessage: res.status === 'executed' ? undefined : res.message,
    })
    if (res.status === 'executed') anyExecuted = true
    else anyFailed = true
  }

  return anyExecuted ? 'rebalanced' : anyFailed ? 'failed' : 'skipped'
}
