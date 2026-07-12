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

// Every entry below was individually verified on-chain (creator address check
// against the official deployer) before being added. Contracts are immutable, so a
// once-verified entry stays valid — this baseline exists because building the list
// purely at runtime needs ~50 Blockscout lookups per refresh, and their rate limiting
// silently dropped real tokens (NVDA, the highest-volume stock token, vanished from
// the registry in production). New listings are still discovered dynamically on top.
const VERIFIED_BASELINE: { symbol: string; name: string; address: string }[] = [
  { symbol: 'AAPL', name: "Apple", address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' },
  { symbol: 'AMD', name: "AMD", address: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC' },
  { symbol: 'AMZN', name: "Amazon", address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54' },
  { symbol: 'ASML', name: "ASML Holding NV", address: '0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA' },
  { symbol: 'ASTS', name: "AST SpaceMobile", address: '0x1AF6446f07eb1d97c546AFC8c9544cBDF3AD5137' },
  { symbol: 'AVGO', name: "Broadcom", address: '0x156E175DD063a8cE274C50654eF40e0032b3fbcF' },
  { symbol: 'BABA', name: "Alibaba", address: '0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4' },
  { symbol: 'COIN', name: "Coinbase", address: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b' },
  { symbol: 'COST', name: "Costco", address: '0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2' },
  { symbol: 'CRCL', name: "Circle Internet Group", address: '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5' },
  { symbol: 'CRWV', name: "CoreWeave", address: '0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3' },
  { symbol: 'DELL', name: "Dell", address: '0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd' },
  { symbol: 'GME', name: "GameStop", address: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E' },
  { symbol: 'GOOGL', name: "Alphabet Class A", address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3' },
  { symbol: 'INTC', name: "Intel", address: '0xc72b96e0E48ecd4DC75E1e45396e26300BC39681' },
  { symbol: 'IREN', name: "IREN Limited", address: '0xF0AB0c93bE6F41369d302e55db1A96b3c430212D' },
  { symbol: 'LLY', name: "Eli Lilly", address: '0x8005d266423c7ea827372c9c864491e5786600ea' },
  { symbol: 'META', name: "Meta Platforms", address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35' },
  { symbol: 'MRVL', name: "Marvell Technology", address: '0x62fd0668e10D8B72339BE2DCF7643001688ff13B' },
  { symbol: 'MSFT', name: "Microsoft", address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74' },
  { symbol: 'MSTR', name: "Strategy Inc.", address: '0xec262a75e413fAfD0dF80480274532C79D42da09' },
  { symbol: 'MU', name: "Micron Technology", address: '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD' },
  { symbol: 'NBIS', name: "Nebius Group", address: '0x9D9c6684F596F66a64C030B93A886D51Fd4D7931' },
  { symbol: 'NFLX', name: "Netflix", address: '0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8' },
  { symbol: 'NOW', name: "ServiceNow", address: '0x0C3260aF4B8f13a69c4c2dFb84fD667890CDFa14' },
  { symbol: 'NVDA', name: "NVIDIA", address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' },
  { symbol: 'NVTS', name: "Navitas Semiconductor", address: '0xbE6702d7b70315376dC48a3293f24f0982F86386' },
  { symbol: 'ORCL', name: "Oracle", address: '0xb0992820E760d836549ba69BC7598b4af75dEE03' },
  { symbol: 'PLTR', name: "Palantir Technologies", address: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A' },
  { symbol: 'QBTS', name: "D-Wave Quantum", address: '0xC583c60aeF9Dc401Da72cEC1B404743a93cea1Cc' },
  { symbol: 'QCOM', name: "Qualcomm", address: '0x0f17206447090e464C277571124dD2688E48AEA9' },
  { symbol: 'QQQ', name: "Invesco QQQ", address: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68' },
  { symbol: 'QUBT', name: "Quantum Computing", address: '0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4' },
  { symbol: 'RBLX', name: "Roblox", address: '0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8' },
  { symbol: 'RGTI', name: "Rigetti Computing", address: '0x284358abc07F9359f19f4b5b4aC91901Be2597Ba' },
  { symbol: 'SGOV', name: "iShares 0-3 Month Treasury Bond ETF", address: '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5' },
  { symbol: 'SLV', name: "iShares Silver Trust", address: '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f' },
  { symbol: 'SNDK', name: "Sandisk Corporation", address: '0xB90A19fF0Af67f7779afF50A882A9CfF42446400' },
  { symbol: 'SOFI', name: "SoFi Technologies", address: '0x98E75885157C80992A8D41b696D8c9C6Fb30A926' },
  { symbol: 'SOXX', name: "iShares Semiconductor ETF", address: '0x75742c18BC1f1C5c5f448f4C9D9C6F66dafAAa38' },
  { symbol: 'SPCX', name: "Space Exploration Technologies Corp", address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa' },
  { symbol: 'SPY', name: "SPDR S&P 500 ETF Trust", address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C' },
  { symbol: 'TSLA', name: "Tesla", address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d' },
  { symbol: 'TSM', name: "Taiwan Semiconductor Manufacturing", address: '0x58FfE4a942d3885bAa22D7520691F611EF09e7AA' },
  { symbol: 'TTWO', name: "Take-Two Interactive Software", address: '0x5e81213613b6B86EaB4c6c50d718d34359459786' },
  { symbol: 'USAR', name: "USA Rare Earth", address: '0xd917B029C761D264c6A312BBbcDA868658eF86a6' },
  { symbol: 'USO', name: "United States Oil Fund", address: '0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344' },
  { symbol: 'XNDU', name: "Xanadu Quantum", address: '0xA8eB3BCcbf2017eE7CBfb652eB51CF2E1B153289' },
  { symbol: 'XOM', name: "ExxonMobil Holdings Corporation", address: '0xf9B46d3D1B22199D4D1025a9cEDB540A33F1a2d5' },
  { symbol: 'ZS', name: "Zscaler", address: '0x7dc013eB55e436f30d7ED1AFE4E36d6e45e3c3f7' },
]

// New listings appear rarely; discovery adds them on top of the baseline with the
// same creator check, and a discovery failure can never remove a baseline entry.
const CACHE_TTL_MS = 10 * 60 * 1000
let cachedRegistry: { symbol: string; name: string; address: string }[] | null = null
let cacheExpiresAt = 0

async function fetchVerifiedRegistry(): Promise<{ symbol: string; name: string; address: string }[]> {
  if (cachedRegistry && Date.now() < cacheExpiresAt) return cachedRegistry

  const known = new Set(VERIFIED_BASELINE.map((t) => t.address.toLowerCase()))
  const discovered: { symbol: string; name: string; address: string }[] = []

  try {
    const res = await fetch(`${BLOCKSCOUT_BASE}/search?q=${encodeURIComponent('Robinhood Token')}`)
    if (res.ok) {
      const data = (await res.json()) as {
        items?: { type: string; name?: string; symbol?: string; address_hash?: string }[]
      }
      const candidates = (data.items || []).filter(
        (i) =>
          i.type === 'token' &&
          i.name?.endsWith(NAME_SUFFIX) &&
          i.symbol &&
          i.address_hash &&
          !known.has(i.address_hash.toLowerCase()),
      )

      // Sequential on purpose: parallel bursts are what got rate-limited. Normally
      // zero candidates reach this point, so the loop costs nothing.
      for (const c of candidates) {
        try {
          const addrRes = await fetch(`${BLOCKSCOUT_BASE}/addresses/${c.address_hash}`)
          if (!addrRes.ok) continue
          const addr = (await addrRes.json()) as { creator_address_hash?: string }
          if (addr.creator_address_hash?.toLowerCase() === OFFICIAL_STOCK_DEPLOYER.toLowerCase()) {
            discovered.push({
              symbol: c.symbol!,
              name: c.name!.replace(NAME_SUFFIX, '').trim(),
              address: c.address_hash!,
            })
          }
        } catch {
          // Discovery is additive only — a failed lookup just means the token shows
          // up on a later refresh.
        }
      }
    }
  } catch {
    // Search being down never affects the baseline.
  }

  cachedRegistry = [...VERIFIED_BASELINE, ...discovered]
  cacheExpiresAt = Date.now() + CACHE_TTL_MS
  return cachedRegistry
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
