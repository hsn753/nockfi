import { createPublicClient, http, formatUnits, parseAbiItem } from 'viem'
import { nockChain } from './chain'
import { MORPHO_CORE } from './get-morpho-markets'
import { getStockTokens } from './get-stock-tokens'

// Stock-token collateral markets on Morpho Blue — the docs' "use stock tokens as
// collateral" capability. Markets are discovered dynamically: every CreateMarket event
// on the core contract whose collateralToken is an OFFICIAL verified stock token and
// whose loan side is USDG. Registry membership is the authenticity gate — a market
// against a same-ticker impersonator token can never appear here, exactly like the
// trading path. Verified live: TSLA/USDG at 77% LLTV with a working oracle
// (price matched spot within cents when checked) and real supply/borrow activity.

const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const USDG_DECIMALS = 6
const STOCK_DECIMALS = 18

const CREATE_MARKET_EVENT = parseAbiItem(
  'event CreateMarket(bytes32 indexed id, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)',
)

const MORPHO_VIEW_ABI = [
  {
    type: 'function', name: 'market', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [
      { type: 'uint128', name: 'totalSupplyAssets' },
      { type: 'uint128', name: 'totalSupplyShares' },
      { type: 'uint128', name: 'totalBorrowAssets' },
      { type: 'uint128', name: 'totalBorrowShares' },
      { type: 'uint128', name: 'lastUpdate' },
      { type: 'uint128', name: 'fee' },
    ],
  },
  {
    type: 'function', name: 'position', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'address' }],
    outputs: [
      { type: 'uint256', name: 'supplyShares' },
      { type: 'uint128', name: 'borrowShares' },
      { type: 'uint128', name: 'collateral' },
    ],
  },
] as const

const ORACLE_ABI = [
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const IRM_ABI = [
  {
    type: 'function', name: 'borrowRateView', stateMutability: 'view',
    inputs: [
      {
        type: 'tuple', name: 'marketParams',
        components: [
          { type: 'address', name: 'loanToken' },
          { type: 'address', name: 'collateralToken' },
          { type: 'address', name: 'oracle' },
          { type: 'address', name: 'irm' },
          { type: 'uint256', name: 'lltv' },
        ],
      },
      {
        type: 'tuple', name: 'market',
        components: [
          { type: 'uint128', name: 'totalSupplyAssets' },
          { type: 'uint128', name: 'totalSupplyShares' },
          { type: 'uint128', name: 'totalBorrowAssets' },
          { type: 'uint128', name: 'totalBorrowShares' },
          { type: 'uint128', name: 'lastUpdate' },
          { type: 'uint128', name: 'fee' },
        ],
      },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

const rpcClient = createPublicClient({ chain: nockChain, transport: http(process.env.RPC_URL) })

const SECONDS_PER_YEAR = 365 * 24 * 3600
// Morpho oracles quote 1 collateral unit in loan units scaled by
// 1e(36 + loanDecimals - collateralDecimals) → for TSLA(18)/USDG(6) that is 1e24.
const ORACLE_PRICE_SCALE = 1e24

export type StockCollateralMarket = {
  id: `0x${string}`
  params: {
    loanToken: `0x${string}`
    collateralToken: `0x${string}`
    oracle: `0x${string}`
    irm: `0x${string}`
    lltv: bigint
  }
  stockSymbol: string
  stockName: string
}

// Morpho markets are immutable once created, so the discovered list only ever grows —
// cache it and only re-scan periodically to pick up newly created markets.
let marketCache: { markets: StockCollateralMarket[]; fetchedAt: number } | null = null
const CACHE_TTL_MS = 10 * 60 * 1000

export async function getStockCollateralMarkets(): Promise<StockCollateralMarket[]> {
  if (marketCache && Date.now() - marketCache.fetchedAt < CACHE_TTL_MS) return marketCache.markets

  const [logs, stocks] = await Promise.all([
    rpcClient.getLogs({ address: MORPHO_CORE, event: CREATE_MARKET_EVENT, fromBlock: BigInt(0), toBlock: 'latest' }),
    getStockTokens(),
  ])
  const stockByAddress = new Map(stocks.map((s) => [s.address.toLowerCase(), s]))

  const markets: StockCollateralMarket[] = []
  for (const log of logs) {
    const p = log.args.marketParams
    if (!p || !log.args.id) continue
    if (p.loanToken.toLowerCase() !== USDG_ADDRESS.toLowerCase()) continue
    const stock = stockByAddress.get(p.collateralToken.toLowerCase())
    if (!stock) continue // not an official stock token — impersonators can't get in
    markets.push({
      id: log.args.id,
      params: {
        loanToken: p.loanToken, collateralToken: p.collateralToken,
        oracle: p.oracle, irm: p.irm, lltv: p.lltv,
      },
      stockSymbol: stock.symbol,
      stockName: stock.name,
    })
  }
  marketCache = { markets, fetchedAt: Date.now() }
  return markets
}

export type StockCollateralMarketData = {
  stockSymbol: string
  stockName: string
  collateralAddress: string
  // Max loan-to-value: how much USDG can be borrowed per dollar of stock collateral
  // before the position becomes liquidatable.
  lltvPct: number
  // What borrowers pay, compounded — live from the IRM, never cached or guessed.
  borrowApyPct: number
  // The market oracle's own price for the stock (the one liquidations use) — can
  // differ slightly from the DEX trading price.
  oraclePriceUsd: number
  // Idle USDG actually available to borrow right now.
  availableLiquidityUsd: number
  totalBorrowedUsd: number
}

export async function getStockCollateralMarketData(): Promise<StockCollateralMarketData[]> {
  const markets = await getStockCollateralMarkets()
  return Promise.all(markets.map(async (m) => {
    const [state, oraclePrice] = await Promise.all([
      rpcClient.readContract({ address: MORPHO_CORE, abi: MORPHO_VIEW_ABI, functionName: 'market', args: [m.id] }),
      rpcClient.readContract({ address: m.params.oracle, abi: ORACLE_ABI, functionName: 'price' }),
    ])
    const marketState = {
      totalSupplyAssets: state[0], totalSupplyShares: state[1],
      totalBorrowAssets: state[2], totalBorrowShares: state[3],
      lastUpdate: state[4], fee: state[5],
    }
    const borrowRatePerSecond = await rpcClient.readContract({
      address: m.params.irm, abi: IRM_ABI, functionName: 'borrowRateView',
      args: [m.params, marketState],
    })
    const borrowApr = (Number(borrowRatePerSecond) / 1e18) * SECONDS_PER_YEAR
    const supply = Number(formatUnits(state[0], USDG_DECIMALS))
    const borrow = Number(formatUnits(state[2], USDG_DECIMALS))
    return {
      stockSymbol: m.stockSymbol,
      stockName: m.stockName,
      collateralAddress: m.params.collateralToken,
      lltvPct: Number(m.params.lltv) / 1e16,
      borrowApyPct: (Math.exp(borrowApr) - 1) * 100,
      oraclePriceUsd: Number(oraclePrice) / ORACLE_PRICE_SCALE,
      availableLiquidityUsd: supply - borrow,
      totalBorrowedUsd: borrow,
    }
  }))
}

export type StockBorrowPosition = {
  stockSymbol: string
  collateralAmount: string // stock units
  collateralValueUsd: number // at the market oracle's price
  borrowedUsd: number
  // borrowed / (collateral value × LLTV): 100% = liquidatable now.
  ltvUtilizationPct: number
  // Oracle price at which the position becomes liquidatable, given current debt.
  liquidationPriceUsd: number | null
}

export async function getStockBorrowPositions(user: string): Promise<StockBorrowPosition[]> {
  const markets = await getStockCollateralMarkets()
  const positions = await Promise.all(markets.map(async (m) => {
    const [pos, state, oraclePrice] = await Promise.all([
      rpcClient.readContract({ address: MORPHO_CORE, abi: MORPHO_VIEW_ABI, functionName: 'position', args: [m.id, user as `0x${string}`] }),
      rpcClient.readContract({ address: MORPHO_CORE, abi: MORPHO_VIEW_ABI, functionName: 'market', args: [m.id] }),
      rpcClient.readContract({ address: m.params.oracle, abi: ORACLE_ABI, functionName: 'price' }),
    ])
    const collateralRaw = pos[2]
    const borrowShares = pos[1]
    if (collateralRaw === BigInt(0) && borrowShares === BigInt(0)) return null

    const totalBorrowAssets = state[2]
    const totalBorrowShares = state[3]
    const borrowedRaw = totalBorrowShares === BigInt(0)
      ? BigInt(0)
      : (borrowShares * totalBorrowAssets) / totalBorrowShares
    const collateralUnits = Number(formatUnits(collateralRaw, STOCK_DECIMALS))
    const priceUsd = Number(oraclePrice) / ORACLE_PRICE_SCALE
    const collateralValueUsd = collateralUnits * priceUsd
    const borrowedUsd = Number(formatUnits(borrowedRaw, USDG_DECIMALS))
    const lltv = Number(m.params.lltv) / 1e18
    const maxDebtUsd = collateralValueUsd * lltv
    return {
      stockSymbol: m.stockSymbol,
      collateralAmount: collateralUnits.toLocaleString('en-US', { maximumFractionDigits: 8 }),
      collateralValueUsd,
      borrowedUsd,
      ltvUtilizationPct: maxDebtUsd > 0 ? (borrowedUsd / maxDebtUsd) * 100 : 0,
      liquidationPriceUsd: collateralUnits > 0 && borrowedUsd > 0
        ? borrowedUsd / (collateralUnits * lltv)
        : null,
    }
  }))
  return positions.filter((p): p is StockBorrowPosition => p !== null)
}
