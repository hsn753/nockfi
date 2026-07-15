// Live reference prices, no API key required. ETH: CoinGecko spot price. USDG is a
// stablecoin, hardcoded to 1.
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

// $NOCK, the project's official token — priced live from DexScreener (no fixed price like
// USDG). Kept here so holdings AND the swap value/spend-limit check price it the same way.
const NOCK_ADDRESS = '0x1b27fF6e68A2fd6490543b17C996c109E64eb432'

async function getNockPriceUsd(): Promise<number | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${NOCK_ADDRESS}`, {
      next: { revalidate: 30 },
    })
    if (!res.ok) return null
    const pairs = (await res.json()) as { priceUsd?: string }[]
    const raw = Array.isArray(pairs) && pairs[0]?.priceUsd ? parseFloat(pairs[0].priceUsd) : NaN
    return Number.isFinite(raw) ? raw : null
  } catch {
    return null
  }
}

export async function getReferencePrices(): Promise<Record<string, number>> {
  const [ethPrice, nockPrice] = await Promise.all([getEthPriceUsd(), getNockPriceUsd()])

  const prices: Record<string, number> = { USDG: 1 }
  if (ethPrice !== null) {
    prices.ETH = ethPrice
    prices.WETH = ethPrice
  }
  if (nockPrice !== null) prices.NOCK = nockPrice
  return prices
}
