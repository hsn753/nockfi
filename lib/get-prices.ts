// Live reference prices, no API key required.
// ETH: CoinGecko spot price. Stock/ETF tokens: the real underlying security's market price
// via Yahoo Finance's public chart endpoint — that IS the correct reference price for a
// tokenized stock (price exposure to the real security, not a separate onchain market).
// A ticker with no real public market (e.g. a tokenized private company) will just come
// back null here and get_reference_prices already handles that gracefully.
const STOCK_TICKERS = [
  'TSLA', 'AMD', 'AMZN', 'AAPL', 'PLTR', 'BABA', 'BE', 'COIN', 'CRCL', 'CRWV',
  'GOOGL', 'INTC', 'META', 'MSFT', 'MU', 'NVDA', 'ORCL', 'SNDK', 'SPCX', 'USAR',
  'QQQ', 'SGOV', 'SLV', 'SPY', 'CUSO',
] as const

async function getEthPriceUsd(): Promise<number | null> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
      next: { revalidate: 30 },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { ethereum?: { usd?: number } }
    return data.ethereum?.usd ?? null
  } catch {
    return null
  }
}

async function getStockPriceUsd(ticker: string): Promise<number | null> {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      next: { revalidate: 30 },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { chart?: { result?: { meta?: { regularMarketPrice?: number } }[] } }
    return data.chart?.result?.[0]?.meta?.regularMarketPrice ?? null
  } catch {
    return null
  }
}

export async function getReferencePrices(): Promise<Record<string, number>> {
  const [ethPrice, ...stockPrices] = await Promise.all([
    getEthPriceUsd(),
    ...STOCK_TICKERS.map(getStockPriceUsd),
  ])

  const prices: Record<string, number> = { USDG: 1 }
  if (ethPrice !== null) {
    prices.ETH = ethPrice
    prices.WETH = ethPrice
  }
  STOCK_TICKERS.forEach((ticker, i) => {
    const price = stockPrices[i]
    if (price !== null) prices[ticker] = price
  })
  return prices
}
