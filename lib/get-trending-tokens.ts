// Robinhood Chain has real, active memecoin trading (Uniswap volume in the hundreds of
// millions within days of launch), but it's fully permissionless — anyone can deploy a
// token. A live search already turned up multiple different contracts all calling
// themselves "ROBINHOOD" or "HOOD" at different addresses: classic impersonator/scam
// behavior. There is no vetted list for this the way there is for Robinhood's own stock
// tokens, so this only ever returns what DexScreener's public API reports, with minimum
// liquidity/volume filters to cut the most obviously dead or fake pools — not a safety
// guarantee. Every caller of this must treat results as unverified and say so to the user.
const DEXSCREENER_SEARCH = 'https://api.dexscreener.com/latest/dex/search'
const MIN_LIQUIDITY_USD = 10000
const MIN_VOLUME_24H_USD = 5000

export type TrendingToken = {
  symbol: string
  address: string
  priceUsd: number | null
  volume24hUsd: number
  liquidityUsd: number
  pairUrl: string
}

type DexScreenerPair = {
  chainId: string
  baseToken: { symbol: string; address: string }
  priceUsd?: string
  volume?: { h24?: number }
  liquidity?: { usd?: number }
  url: string
}

async function searchDexScreener(query: string): Promise<DexScreenerPair[]> {
  const res = await fetch(`${DEXSCREENER_SEARCH}?q=${encodeURIComponent(query)}`)
  if (!res.ok) return []
  const data = (await res.json()) as { pairs?: DexScreenerPair[] }
  return (data.pairs || []).filter((p) => p.chainId === 'robinhood')
}

function toTrendingToken(p: DexScreenerPair): TrendingToken {
  return {
    symbol: p.baseToken.symbol,
    address: p.baseToken.address,
    priceUsd: p.priceUsd ? parseFloat(p.priceUsd) : null,
    volume24hUsd: p.volume?.h24 ?? 0,
    liquidityUsd: p.liquidity?.usd ?? 0,
    pairUrl: p.url,
  }
}

// Top tokens by 24h volume on Robinhood Chain right now, above the minimum liquidity/
// volume bar. Multiple entries can share a symbol (impersonators) — never dedupe by
// symbol, always keep addresses distinct so the caller can flag ambiguity.
export async function getTrendingTokens(limit = 10): Promise<TrendingToken[]> {
  const pairs = await searchDexScreener('robinhood')
  return pairs
    .filter((p) => (p.liquidity?.usd ?? 0) >= MIN_LIQUIDITY_USD && (p.volume?.h24 ?? 0) >= MIN_VOLUME_24H_USD)
    .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
    .map(toTrendingToken)
    .filter((t, i, arr) => arr.findIndex((x) => x.address.toLowerCase() === t.address.toLowerCase()) === i)
    .slice(0, limit)
}

// Looks up all Robinhood Chain tokens matching a symbol (case-insensitive), sorted by
// volume. Returns every distinct address found — including likely impersonators — so
// the caller can present the ambiguity rather than silently guessing.
export async function findTokensBySymbol(symbol: string): Promise<TrendingToken[]> {
  const pairs = await searchDexScreener(`${symbol} robinhood`)
  return pairs
    .filter((p) => p.baseToken.symbol.toLowerCase() === symbol.toLowerCase())
    .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
    .map(toTrendingToken)
    .filter((t, i, arr) => arr.findIndex((x) => x.address.toLowerCase() === t.address.toLowerCase()) === i)
}
