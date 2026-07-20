import { PERPS_ENABLED } from './feature-flags'

// Data source for perps market reads. Defaults to Lighter mainnet; can be pointed at the
// Robinhood Chain instance (https://api.rh.lighter.xyz/api/v1) via LIGHTER_DATA_BASE so the
// mark price Robin shows matches the venue the executor actually fills on (account 703, USDG
// margin). Same REST shape on both. Env-driven so prod stays on the default untouched.
const LIGHTER_API_BASE = process.env.LIGHTER_DATA_BASE || 'https://mainnet.zklighter.elliot.ai/api/v1'

// Lighter's real market list spans far more than crypto — tokenized stock/index
// perpetuals (AAPL, TSLA, SPY, QQQ...), forex pairs, and commodities all trade
// alongside BTC/ETH-style crypto. That overlaps with the compliance rule already in
// Robin's system prompt (no stock/regulated-security exposure through Nock), and many
// of the remaining tickers are genuinely ambiguous to classify from the API alone
// (e.g. "STABLE", "H100", "OPENAI" — private-company synthetic exposure, not obviously
// crypto or obviously equity). Rather than guess a denylist for everything non-crypto,
// this is an allowlist of tickers confirmed as real crypto/memecoin assets — anything
// not explicitly listed here is excluded by default, the safer failure mode. Extend
// this list only once a new symbol has been explicitly confirmed as genuine crypto.
const CRYPTO_ALLOWLIST = new Set([
  // Majors
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'LTC', 'BCH', 'LINK', 'UNI', 'AAVE', 'CRV',
  // L1/L2/DeFi
  'ARB', 'OP', 'SUI', 'APT', 'NEAR', 'ICP', 'FIL', 'HBAR', 'TRX', 'XLM', 'XMR', 'ZEC', 'TIA', 'SEI', 'STRK',
  'JTO', 'JUP', 'PYTH', 'DYDX', 'GMX', 'ENA', 'EIGEN', 'ETHFI', 'LDO', 'MORPHO', 'ONDO', 'PENDLE', 'QNT',
  'TAO', 'WLD', 'ZK', 'ZRO', 'CRO', 'MNT', 'POL', 'AZTEC', 'LIT', 'SKY', 'LINEA',
  // Memecoins
  '1000BONK', '1000FLOKI', '1000NOT', '1000PEPE', '1000SHIB', 'WIF', 'TRUMP', 'WEN', 'PUMP', 'FARTCOIN',
  'POPCAT', 'PENGU', 'VIRTUAL', 'KAITO', 'GRASS', 'ASTER',
])

type LighterOrderBookDetail = {
  symbol: string
  market_id: number
  status: string
  mark_price: string
  index_price: string
  daily_quote_token_volume: number
  daily_price_change: number
  open_interest: number
  default_initial_margin_fraction: number
}

type LighterFundingRate = {
  market_id: number
  exchange: string
  symbol: string
  rate: number
}

export type PerpMarket = {
  asset: string
  markPrice: number
  indexPrice: number
  // Hourly rate, as a percentage — Lighter pays funding every hour (per their docs),
  // unlike the common 8h convention on many other perps venues. Null when Lighter
  // doesn't return a funding entry for this market (never fabricated as 0).
  fundingRatePctHourly: number | null
  openInterest: number
  dailyVolumeUsd: number
  priceChange24hPct: number
  // Derived from Lighter's own live default_initial_margin_fraction, not guessed —
  // e.g. a fraction of 500 (5%) means 20x max leverage. Null when the fraction is
  // missing or zero (never Infinity from a divide-by-zero).
  maxLeverage: number | null
}

const DEFAULT_MARKET_LIMIT = 15

export async function getPerpsMarkets(symbol?: string): Promise<{ markets: PerpMarket[]; note: string }> {
  const [orderBooksRes, fundingRes] = await Promise.all([
    fetch(`${LIGHTER_API_BASE}/orderBookDetails`),
    fetch(`${LIGHTER_API_BASE}/funding-rates`),
  ])

  if (!orderBooksRes.ok || !fundingRes.ok) {
    throw new Error('Lighter API request failed')
  }

  const [orderBooksData, fundingData] = await Promise.all([orderBooksRes.json(), fundingRes.json()])
  const orderBooks = orderBooksData.order_book_details as LighterOrderBookDetail[]
  const fundingRates = fundingData.funding_rates as LighterFundingRate[]

  // funding-rates returns cross-exchange reference rates (binance/bybit/hyperliquid)
  // alongside Lighter's own — only the "lighter" entry is what actually applies to a
  // position opened there.
  const fundingByMarketId = new Map<number, number>()
  for (const f of fundingRates) {
    if (f.exchange === 'lighter') fundingByMarketId.set(f.market_id, f.rate)
  }

  let eligible = orderBooks.filter((m) => m.status === 'active' && CRYPTO_ALLOWLIST.has(m.symbol))

  if (symbol) {
    const upper = symbol.toUpperCase()
    eligible = eligible.filter((m) => m.symbol === upper)
  } else {
    eligible = [...eligible]
      .sort((a, b) => b.daily_quote_token_volume - a.daily_quote_token_volume)
      .slice(0, DEFAULT_MARKET_LIMIT)
  }

  const markets: PerpMarket[] = eligible.map((m) => ({
    asset: m.symbol,
    markPrice: Number(m.mark_price),
    indexPrice: Number(m.index_price),
    fundingRatePctHourly: fundingByMarketId.has(m.market_id)
      ? (fundingByMarketId.get(m.market_id) as number) * 100
      : null,
    openInterest: m.open_interest,
    dailyVolumeUsd: m.daily_quote_token_volume,
    priceChange24hPct: m.daily_price_change,
    maxLeverage:
      m.default_initial_margin_fraction > 0
        ? Math.round(10000 / m.default_initial_margin_fraction)
        : null,
  }))

  return {
    markets,
    note: `Real live data from Lighter (mainnet.zklighter.elliot.ai) — a separate perps exchange that accepts Robinhood Chain assets (USDG) as margin. Funding is hourly. ${PERPS_ENABLED ? "Opening a position is live for eligible jurisdictions — call propose_action with the 'perps' object to attempt it; the system enforces the region gate." : 'Opening a position is region-gated and launching soon for eligible jurisdictions, so this is informational for now.'} Only crypto/memecoin markets are shown here, even though Lighter also lists stock, index, forex, and commodity perpetuals.`,
  }
}
