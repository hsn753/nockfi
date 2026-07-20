import { LIGHTER_BASE } from './lighter-account'

// Server-side reader for a user's Lighter (perps) account, so their holdings answer and
// portfolio total include the USDG they deposited as margin AND their open perp positions
// — neither of which lives in the wallet's token balances. Read-only public API; safe to
// call from a route. Returns null-ish (hasAccount: false) when the wallet never onboarded.

export type LighterPerpPosition = {
  symbol: string
  side: 'long' | 'short'
  size: number // absolute base size
  entryPrice: number
  notionalUsd: number // |position_value|
  unrealizedPnlUsd: number
  leverage: number | null // derived from the position's initial margin fraction
}

export type LighterPortfolio = {
  hasAccount: boolean
  accountIndex: number | null
  // Deposited margin balance held on Lighter (USDG). This left the wallet on deposit, so
  // it is NOT double-counted with wallet USDG.
  collateralUsd: number
  availableUsd: number
  // Account equity = collateral + unrealized PnL across open positions. This is the real
  // user value on Lighter to fold into the portfolio total.
  equityUsd: number
  positions: LighterPerpPosition[]
}

const EMPTY: LighterPortfolio = {
  hasAccount: false,
  accountIndex: null,
  collateralUsd: 0,
  availableUsd: 0,
  equityUsd: 0,
  positions: [],
}

export async function getLighterPortfolio(l1Address: string): Promise<LighterPortfolio> {
  try {
    // Resolve the account index for this L1 address.
    const lookupRes = await fetch(`${LIGHTER_BASE}/api/v1/accountsByL1Address?l1_address=${l1Address}`)
    if (!lookupRes.ok) return EMPTY
    const lookup = (await lookupRes.json()) as { sub_accounts?: Array<{ index: number }> }
    const accountIndex = lookup.sub_accounts?.[0]?.index
    if (accountIndex === undefined) return EMPTY

    // Full account state: collateral + positions.
    const acctRes = await fetch(`${LIGHTER_BASE}/api/v1/account?by=index&value=${accountIndex}`)
    if (!acctRes.ok) return { ...EMPTY, hasAccount: true, accountIndex }
    const acctData = (await acctRes.json()) as {
      accounts?: Array<{
        collateral?: string
        available_balance?: string
        positions?: Array<Record<string, unknown>>
      }>
    }
    const a = acctData.accounts?.[0]
    if (!a) return { ...EMPTY, hasAccount: true, accountIndex }

    const collateralUsd = parseFloat(a.collateral ?? '0') || 0
    const availableUsd = parseFloat(a.available_balance ?? '0') || 0

    const positions: LighterPerpPosition[] = []
    let totalUnrealized = 0
    for (const p of a.positions ?? []) {
      const size = Math.abs(parseFloat(String(p.position ?? '0')))
      if (size === 0) continue
      const uPnl = parseFloat(String(p.unrealized_pnl ?? '0')) || 0
      totalUnrealized += uPnl
      const imf = parseFloat(String(p.initial_margin_fraction ?? '0'))
      positions.push({
        symbol: String(p.symbol ?? ''),
        side: Number(p.sign) === 1 ? 'long' : 'short',
        size,
        entryPrice: parseFloat(String(p.avg_entry_price ?? '0')) || 0,
        notionalUsd: Math.abs(parseFloat(String(p.position_value ?? '0'))) || 0,
        unrealizedPnlUsd: uPnl,
        leverage: imf > 0 ? Math.round(100 / imf) : null,
      })
    }

    return {
      hasAccount: true,
      accountIndex,
      collateralUsd,
      availableUsd,
      equityUsd: Number((collateralUsd + totalUnrealized).toFixed(6)),
      positions,
    }
  } catch {
    return EMPTY
  }
}
