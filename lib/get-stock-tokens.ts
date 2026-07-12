// Robinhood's official tokenized stocks on Robinhood Chain. Real ERC-20s named
// "<Company> • Robinhood Token" (AAPL, TSLA, NVDA, SPY...), trading 24/7 on Uniswap
// against USDG/ETH. Impersonators with identical symbols are rampant — four different
// fake TSLAs turned up in one search — so the name pattern alone is not enough to
// trust a contract. Every official token checked shares a single deployer, and that's
// the authenticity anchor: registry membership requires BOTH the name pattern AND the
// creator address matching. A stock token is price exposure, not share ownership —
// no dividends, no voting rights — and every caller must present it that way.
export const OFFICIAL_STOCK_DEPLOYER = '0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046'

const BLOCKSCOUT_BASE = 'https://robinhoodchain.blockscout.com/api/v2'
const NAME_SUFFIX = '• Robinhood Token'

export type StockToken = {
  symbol: string
  name: string // company name, suffix stripped
  address: string
  priceUsd: number | null
  liquidityUsd: number
  volume24hUsd: number
}

// The registry changes rarely (new listings), but the creator-verification step costs
// one Blockscout call per token — cache the verified list and refresh lazily.
const CACHE_TTL_MS = 10 * 60 * 1000
let cachedRegistry: { symbol: string; name: string; address: string }[] | null = null
let cacheExpiresAt = 0

async function fetchVerifiedRegistry(): Promise<{ symbol: string; name: string; address: string }[]> {
  if (cachedRegistry && Date.now() < cacheExpiresAt) return cachedRegistry

  const res = await fetch(`${BLOCKSCOUT_BASE}/search?q=${encodeURIComponent('Robinhood Token')}`)
  if (!res.ok) throw new Error(`Blockscout search failed: ${res.status}`)
  const data = (await res.json()) as {
    items?: { type: string; name?: string; symbol?: string; address_hash?: string }[]
  }

  const candidates = (data.items || []).filter(
    (i) => i.type === 'token' && i.name?.endsWith(NAME_SUFFIX) && i.symbol && i.address_hash,
  )

  // Anyone can copy the name; nobody can copy the deployer. Check each candidate's
  // creator and drop anything not deployed by Robinhood's official deployer address.
  const verified = await Promise.all(
    candidates.map(async (c) => {
      try {
        const addrRes = await fetch(`${BLOCKSCOUT_BASE}/addresses/${c.address_hash}`)
        if (!addrRes.ok) return null
        const addr = (await addrRes.json()) as { creator_address_hash?: string }
        if (addr.creator_address_hash?.toLowerCase() !== OFFICIAL_STOCK_DEPLOYER.toLowerCase()) return null
        return {
          symbol: c.symbol!,
          name: c.name!.replace(NAME_SUFFIX, '').trim(),
          address: c.address_hash!,
        }
      } catch {
        return null
      }
    }),
  )

  const registry = verified.filter((v): v is NonNullable<typeof v> => v !== null)
  if (registry.length > 0) {
    cachedRegistry = registry
    cacheExpiresAt = Date.now() + CACHE_TTL_MS
  }
  return registry
}

type DexScreenerPair = {
  chainId: string
  baseToken: { symbol: string; address: string }
  priceUsd?: string
  volume?: { h24?: number }
  liquidity?: { usd?: number }
}

// Batch price lookup — DexScreener accepts up to 30 comma-separated addresses per call.
async function fetchPrices(addresses: string[]): Promise<Map<string, { priceUsd: number | null; liquidityUsd: number; volume24hUsd: number }>> {
  const out = new Map<string, { priceUsd: number | null; liquidityUsd: number; volume24hUsd: number }>()
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30)
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${batch.join(',')}`)
      if (!res.ok) continue
      const pairs = (await res.json()) as DexScreenerPair[]
      if (!Array.isArray(pairs)) continue
      for (const p of pairs) {
        const key = p.baseToken.address.toLowerCase()
        const existing = out.get(key)
        const liquidity = p.liquidity?.usd ?? 0
        // A token can have several pools; keep the deepest one's price, but sum volume.
        if (!existing || liquidity > existing.liquidityUsd) {
          out.set(key, {
            priceUsd: p.priceUsd ? parseFloat(p.priceUsd) : null,
            liquidityUsd: liquidity,
            volume24hUsd: (existing?.volume24hUsd ?? 0) + (p.volume?.h24 ?? 0),
          })
        } else {
          existing.volume24hUsd += p.volume?.h24 ?? 0
        }
      }
    } catch {
      // Price enrichment is best-effort; the registry itself is the critical part.
    }
  }
  return out
}

export async function getStockTokens(): Promise<StockToken[]> {
  const registry = await fetchVerifiedRegistry()
  const prices = await fetchPrices(registry.map((r) => r.address))

  return registry
    .map((r) => {
      const p = prices.get(r.address.toLowerCase())
      return {
        ...r,
        priceUsd: p?.priceUsd ?? null,
        liquidityUsd: p?.liquidityUsd ?? 0,
        volume24hUsd: p?.volume24hUsd ?? 0,
      }
    })
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
}

// The ONLY correct way to resolve a stock symbol to a contract address. Exact
// case-insensitive match against the verified registry — never a fuzzy DEX search,
// which surfaces the impersonators.
export async function findStockToken(symbol: string): Promise<StockToken | null> {
  const all = await getStockTokens()
  return all.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase()) ?? null
}
