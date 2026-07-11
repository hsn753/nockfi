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

export async function getReferencePrices(): Promise<Record<string, number>> {
  const ethPrice = await getEthPriceUsd()

  const prices: Record<string, number> = { USDG: 1 }
  if (ethPrice !== null) {
    prices.ETH = ethPrice
    prices.WETH = ethPrice
  }
  return prices
}
