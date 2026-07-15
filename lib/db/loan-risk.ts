import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from './client'
import { loanRiskEvents } from './schema'
import type { StockBorrowPosition } from '../get-stock-collateral'

// Open an event when a loan crosses RISK_OPEN_PCT; resolve when it comes back
// under RISK_RESOLVE_PCT or the position closes. The gap between the two is
// hysteresis — a loan hovering at exactly 80% must not open/resolve a new event
// on every sweep.
export const RISK_OPEN_PCT = 80
export const RISK_RESOLVE_PCT = 75

export type LoanRiskEventRow = typeof loanRiskEvents.$inferSelect

export async function getUnresolvedRiskEvents(walletId: string): Promise<LoanRiskEventRow[]> {
  const db = getDb()
  return db
    .select()
    .from(loanRiskEvents)
    .where(and(eq(loanRiskEvents.walletId, walletId), isNull(loanRiskEvents.resolvedAt)))
}

// Reconciles the persisted events for one wallet against its live positions.
// Returns how many events were opened/resolved (for the cron's summary).
export async function syncLoanRiskEvents(
  walletId: string,
  positions: StockBorrowPosition[],
): Promise<{ opened: number; resolved: number }> {
  const db = getDb()
  const open = await getUnresolvedRiskEvents(walletId)
  const bySymbol = new Map(positions.map((p) => [p.stockSymbol, p]))
  let opened = 0
  let resolved = 0

  // Resolve events whose loan is now healthy or gone.
  for (const ev of open) {
    const pos = bySymbol.get(ev.stockSymbol)
    if (!pos || pos.ltvUtilizationPct < RISK_RESOLVE_PCT) {
      await db
        .update(loanRiskEvents)
        .set({ resolvedAt: new Date() })
        .where(eq(loanRiskEvents.id, ev.id))
      resolved++
    }
  }

  // Open events for newly risky loans that don't already have one.
  const openSymbols = new Set(open.map((e) => e.stockSymbol))
  for (const pos of positions) {
    if (pos.ltvUtilizationPct >= RISK_OPEN_PCT && !openSymbols.has(pos.stockSymbol)) {
      await db.insert(loanRiskEvents).values({
        walletId,
        stockSymbol: pos.stockSymbol,
        ltvUtilizationPct: pos.ltvUtilizationPct.toFixed(2),
        liquidationPriceUsd: pos.liquidationPriceUsd?.toFixed(2) ?? null,
        // Store the observed oracle price directly, not a value reconstructed by dividing
        // collateralValueUsd by a display-formatted (comma-grouped, 8dp-truncated) amount.
        oraclePriceUsd: pos.oraclePriceUsd.toFixed(2),
        debtUsd: pos.borrowedUsd.toFixed(2),
      })
      opened++
    }
  }

  return { opened, resolved }
}
