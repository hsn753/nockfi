// Robinhood Chain has real, active memecoin trading (Uniswap volume in the hundreds of
// millions within days of launch), but it's fully permissionless — anyone can deploy a
// token. A live search already turned up multiple different contracts all calling
// themselves "ROBINHOOD" or "HOOD" at different addresses (real impersonator behavior),
// plus copycat tokens like "BABYCASHCAT" riding a popular coin's name. There is no
// vetted list for this the way there is for Robinhood's own stock tokens — minimum
// liquidity/volume filters below cut the most obviously dead or fake pools, not a safety
// guarantee. Every caller of this must treat results as unverified and say so to the user.
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

// GeckoTerminal's network-scoped trending pools — genuinely chain-wide (not biased
// toward tokens whose name happens to match a search keyword the way DexScreener's
// /search endpoint is). Confirmed this surfaces the actually-reported top coins
// (CASHCAT, DIH) that a "robinhood" keyword search misses entirely.
async function fetchTrendingPools(): Promise<TrendingToken[]> {
  const res = await fetch('https://api.geckoterminal.com/api/v2/networks/robinhood/trending_pools?include=base_token', {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return []
  const data = (await res.json()) as {
    data?: { relationships: { base_token: { data: { id: string } } }; attributes: { volume_usd?: { h24?: string }; reserve_in_usd?: string; base_token_price_usd?: string } }[]
    included?: { id: string; attributes: { symbol?: string; address?: string } }[]
  }
  const tokensById = new Map((data.included || []).map((t) => [t.id, t.attributes]))

  return (data.data || [])
    .map((pool) => {
      const base = tokensById.get(pool.relationships.base_token.data.id)
      if (!base?.address || !base.symbol) return null
      return {
        symbol: base.symbol,
        address: base.address,
        priceUsd: pool.attributes.base_token_price_usd ? parseFloat(pool.attributes.base_token_price_usd) : null,
        volume24hUsd: parseFloat(pool.attributes.volume_usd?.h24 || '0'),
        liquidityUsd: parseFloat(pool.attributes.reserve_in_usd || '0'),
        pairUrl: `https://www.geckoterminal.com/robinhood/tokens/${base.address}`,
      } satisfies TrendingToken
    })
    .filter((t): t is TrendingToken => t !== null)
}

// DexScreener's search endpoint, used only for symbol-specific lookups where searching
// by keyword is the actual intent (unlike the general trending list, where a keyword
// search would miss anything whose name doesn't match).
type DexScreenerPair = {
  chainId: string
  baseToken: { symbol: string; address: string }
  priceUsd?: string
  volume?: { h24?: number }
  liquidity?: { usd?: number }
  url: string
}

async function searchDexScreener(query: string): Promise<DexScreenerPair[]> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`)
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

function dedupeByAddress(tokens: TrendingToken[]): TrendingToken[] {
  return tokens.filter((t, i, arr) => arr.findIndex((x) => x.address.toLowerCase() === t.address.toLowerCase()) === i)
}

// Top tokens by 24h volume on Robinhood Chain right now, above the minimum liquidity/
// volume bar. Multiple entries can share a symbol (impersonators) — never dedupe by
// symbol, always keep addresses distinct so the caller can flag ambiguity.
export async function getTrendingTokens(limit = 10): Promise<TrendingToken[]> {
  const tokens = await fetchTrendingPools()
  return dedupeByAddress(
    tokens
      .filter((t) => t.liquidityUsd >= MIN_LIQUIDITY_USD && t.volume24hUsd >= MIN_VOLUME_24H_USD)
      .sort((a, b) => b.volume24hUsd - a.volume24hUsd),
  ).slice(0, limit)
}

// Looks up all Robinhood Chain tokens matching a symbol (case-insensitive), sorted by
// volume. Returns every distinct address found — including likely impersonators — so
// the caller can present the ambiguity rather than silently guessing.
export async function findTokensBySymbol(symbol: string): Promise<TrendingToken[]> {
  const pairs = await searchDexScreener(`${symbol} robinhood`)
  return dedupeByAddress(
    pairs
      .filter((p) => p.baseToken.symbol.toLowerCase() === symbol.toLowerCase())
      .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
      .map(toTrendingToken),
  )
}
