import { createPublicClient, http, formatUnits, parseUnits, parseAbiItem, encodeFunctionData, erc20Abi } from 'viem'
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

const MORPHO_WRITE_ABI = [
  {
    type: 'function', name: 'supplyCollateral', stateMutability: 'nonpayable',
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
      { type: 'uint256', name: 'assets' },
      { type: 'address', name: 'onBehalf' },
      { type: 'bytes', name: 'data' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'borrow', stateMutability: 'nonpayable',
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
      { type: 'uint256', name: 'assets' },
      { type: 'uint256', name: 'shares' },
      { type: 'address', name: 'onBehalf' },
      { type: 'address', name: 'receiver' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
  },
  {
    type: 'function', name: 'repay', stateMutability: 'nonpayable',
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
      { type: 'uint256', name: 'assets' },
      { type: 'uint256', name: 'shares' },
      { type: 'address', name: 'onBehalf' },
      { type: 'bytes', name: 'data' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
  },
  {
    type: 'function', name: 'withdrawCollateral', stateMutability: 'nonpayable',
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
      { type: 'uint256', name: 'assets' },
      { type: 'address', name: 'onBehalf' },
      { type: 'address', name: 'receiver' },
    ],
    outputs: [],
  },
] as const

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

// Verified baseline, same pattern (and same lesson) as get-stock-tokens' registry
// baseline: dynamic discovery depends on an unbounded eth_getLogs scan that the
// production Alchemy RPC rejects (block-range cap) — confirmed live when every
// borrow attempt failed with "unable to retrieve collateral markets" while local
// runs against the public RPC worked. Morpho market params are immutable once
// created, so a once-verified entry can never go stale. Values read from the
// CreateMarket log and cross-checked against the live oracle/IRM.
const VERIFIED_MARKET_BASELINE: StockCollateralMarket[] = [
  {
    id: '0xf4dff250826a86627545e5c6594b3b249db3ad2ec5eed56c02833d2a67acf445',
    params: {
      loanToken: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      collateralToken: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
      oracle: '0x280855A5BF983bf005f19992C157007930B3de2A',
      irm: '0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1',
      lltv: BigInt('770000000000000000'),
    },
    stockSymbol: 'TSLA',
    stockName: 'Tesla',
  },
]

// The unbounded log scan goes to the chain's PUBLIC RPC, which allows it — never to
// RPC_URL (Alchemy), which caps ranges. Everything else (state reads, quotes) stays
// on RPC_URL.
const discoveryClient = createPublicClient({ chain: nockChain, transport: http('https://rpc.mainnet.chain.robinhood.com') })

// Morpho markets are immutable once created, so the discovered list only ever grows —
// cache it and only re-scan periodically to pick up newly created markets.
let marketCache: { markets: StockCollateralMarket[]; fetchedAt: number } | null = null
const CACHE_TTL_MS = 10 * 60 * 1000

export async function getStockCollateralMarkets(): Promise<StockCollateralMarket[]> {
  if (marketCache && Date.now() - marketCache.fetchedAt < CACHE_TTL_MS) return marketCache.markets

  const markets: StockCollateralMarket[] = [...VERIFIED_MARKET_BASELINE]
  try {
    const [logs, stocks] = await Promise.all([
      discoveryClient.getLogs({ address: MORPHO_CORE, event: CREATE_MARKET_EVENT, fromBlock: BigInt(0), toBlock: 'latest' }),
      getStockTokens(),
    ])
    const stockByAddress = new Map(stocks.map((s) => [s.address.toLowerCase(), s]))
    const known = new Set(markets.map((m) => m.id.toLowerCase()))

    for (const log of logs) {
      const p = log.args.marketParams
      if (!p || !log.args.id) continue
      if (known.has(log.args.id.toLowerCase())) continue
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
  } catch (err) {
    // Discovery is enrichment, not a dependency — the verified baseline always works.
    console.error('[get-stock-collateral] Dynamic market discovery failed, using baseline:', err)
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
  oraclePriceUsd: number // the observed market oracle price (USD per stock unit)
  borrowedUsd: number
  // borrowed / (collateral value × LLTV): 100% = liquidatable now.
  ltvUtilizationPct: number
  // Oracle price at which the position becomes liquidatable, given current debt.
  liquidationPriceUsd: number | null
}

export async function getStockBorrowPositions(user: string): Promise<StockBorrowPosition[]> {
  const all = await getAllStockBorrowPositions([user])
  return all.get(user.toLowerCase()) ?? []
}

// Batch scan built for the monitoring sweep: positions for N wallets × M markets
// go through Multicall3 in chunks, and market state + oracle price are read ONCE
// per market — not once per wallet. The per-wallet loop this replaced was ~4 RPC
// round-trips per wallet, which is a non-starter for a sweep over thousands of
// users (and the reason the single-wallet reader above now just delegates here).
const MULTICALL_CHUNK = 400

export async function getAllStockBorrowPositions(addresses: string[]): Promise<Map<string, StockBorrowPosition[]>> {
  const out = new Map<string, StockBorrowPosition[]>()
  if (addresses.length === 0) return out
  const markets = await getStockCollateralMarkets()
  if (markets.length === 0) return out

  // One state + oracle read per market.
  const marketLive = await Promise.all(markets.map(async (m) => {
    const [state, oraclePrice] = await Promise.all([
      rpcClient.readContract({ address: MORPHO_CORE, abi: MORPHO_VIEW_ABI, functionName: 'market', args: [m.id] }),
      rpcClient.readContract({ address: m.params.oracle, abi: ORACLE_ABI, functionName: 'price' }),
    ])
    return { m, totalBorrowAssets: state[2], totalBorrowShares: state[3], priceUsd: Number(oraclePrice) / ORACLE_PRICE_SCALE }
  }))

  // Every (wallet, market) position via multicall, chunked.
  const calls = addresses.flatMap((addr) => markets.map((m) => ({
    address: MORPHO_CORE as `0x${string}`,
    abi: MORPHO_VIEW_ABI,
    functionName: 'position' as const,
    args: [m.id, addr as `0x${string}`] as const,
  })))
  const results: unknown[] = []
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
    const chunk = await rpcClient.multicall({ contracts: calls.slice(i, i + MULTICALL_CHUNK), allowFailure: true })
    results.push(...chunk)
  }

  addresses.forEach((addr, ai) => {
    const positions: StockBorrowPosition[] = []
    marketLive.forEach((live, mi) => {
      const r = results[ai * markets.length + mi] as { status: string; result?: readonly [bigint, bigint, bigint] }
      if (r.status !== 'success' || !r.result) return
      const [, borrowShares, collateralRaw] = r.result
      if (collateralRaw === BigInt(0) && borrowShares === BigInt(0)) return

      const borrowedRaw = live.totalBorrowShares === BigInt(0)
        ? BigInt(0)
        : (borrowShares * live.totalBorrowAssets) / live.totalBorrowShares
      const collateralUnits = Number(formatUnits(collateralRaw, STOCK_DECIMALS))
      const collateralValueUsd = collateralUnits * live.priceUsd
      const borrowedUsd = Number(formatUnits(borrowedRaw, USDG_DECIMALS))
      const lltv = Number(live.m.params.lltv) / 1e18
      const maxDebtUsd = collateralValueUsd * lltv
      positions.push({
        stockSymbol: live.m.stockSymbol,
        collateralAmount: collateralUnits.toLocaleString('en-US', { maximumFractionDigits: 8 }),
        collateralValueUsd,
        oraclePriceUsd: live.priceUsd,
        borrowedUsd,
        ltvUtilizationPct: maxDebtUsd > 0 ? (borrowedUsd / maxDebtUsd) * 100 : 0,
        liquidationPriceUsd: collateralUnits > 0 && borrowedUsd > 0
          ? borrowedUsd / (collateralUnits * lltv)
          : null,
      })
    })
    out.set(addr.toLowerCase(), positions)
  })
  return out
}

// ---------------------------------------------------------------------------
// Execution quote builders. A borrow or repay is a SEQUENCE of transactions
// (approve handled client-side, then supplyCollateral+borrow / repay+withdraw),
// so quotes carry an ordered `steps` array instead of the single `transaction`
// the swap/yield quotes use. Every number is read live on-chain at quote time —
// same honesty rules as buildMarketSupply/buildMarketWithdraw.
// ---------------------------------------------------------------------------

// New debt is capped at this fraction of the market's hard LLTV so a fresh
// position never starts on the liquidation edge — at 77% LLTV and 85% headroom,
// TSLA has to fall ~13% before liquidation, not 0.1%.
const BORROW_SAFETY_FRACTION = 0.85
const COLLATERAL_GAS_LIMIT = '500000'

export type CollateralStep = {
  label: string
  to: string
  data: string
  value: string
  gas: string
  gasPrice: string
}

export type StockCollateralQuote = {
  kind: 'stock-borrow' | 'stock-repay'
  stockSymbol: string
  steps: CollateralStep[]
  // ERC20 approval the client must ensure before running steps (null = none needed).
  approval: { tokenAddress: string; tokenSymbol: string; tokenDecimals: number; amountRaw: string; spender: string } | null
  collateralDelta: string // stock units posted (borrow) or returned (repay-close), '0' otherwise
  usdgAmount: string // USDG borrowed or repaid
  borrowApyPct: number
  oraclePriceUsd: number
  ltvUtilizationAfterPct: number
  liquidationPriceUsdAfter: number | null
  debtAfterUsd: number
}

async function getMarketBySymbol(stockSymbol: string) {
  const markets = await getStockCollateralMarkets()
  return markets.find((m) => m.stockSymbol.toLowerCase() === stockSymbol.toLowerCase()) ?? null
}

async function readLiveMarket(m: StockCollateralMarket) {
  const [state, oraclePrice, gasPrice] = await Promise.all([
    rpcClient.readContract({ address: MORPHO_CORE, abi: MORPHO_VIEW_ABI, functionName: 'market', args: [m.id] }),
    rpcClient.readContract({ address: m.params.oracle, abi: ORACLE_ABI, functionName: 'price' }),
    rpcClient.getGasPrice(),
  ])
  return {
    totalSupplyAssets: state[0], totalSupplyShares: state[1],
    totalBorrowAssets: state[2], totalBorrowShares: state[3],
    priceUsd: Number(oraclePrice) / ORACLE_PRICE_SCALE,
    gasPrice: (gasPrice * BigInt(2)).toString(),
  }
}

function step(label: string, data: `0x${string}`, gasPrice: string): CollateralStep {
  return { label, to: MORPHO_CORE, data, value: '0', gas: COLLATERAL_GAS_LIMIT, gasPrice }
}

export async function buildStockBorrow(
  user: string,
  stockSymbol: string,
  borrowUsd: string,
  collateralAmount?: string, // stock units to post; default = the user's full wallet balance
): Promise<{ error: string } | StockCollateralQuote> {
  const m = await getMarketBySymbol(stockSymbol)
  if (!m) return { error: `No Morpho market accepts ${stockSymbol.toUpperCase()} as collateral. Only official stock tokens with a live market can back a loan — call get_stock_collateral_info for the current list.` }

  const borrowAssets = parseUnits(borrowUsd.replace(/,/g, ''), USDG_DECIMALS)
  if (borrowAssets <= BigInt(0)) return { error: 'Borrow amount must be greater than zero.' }

  const [live, pos, walletBalance] = await Promise.all([
    readLiveMarket(m),
    rpcClient.readContract({ address: MORPHO_CORE, abi: MORPHO_VIEW_ABI, functionName: 'position', args: [m.id, user as `0x${string}`] }),
    rpcClient.readContract({ address: m.params.collateralToken, abi: erc20Abi, functionName: 'balanceOf', args: [user as `0x${string}`] }),
  ])

  // Idle liquidity is the hard ceiling on any new borrow.
  const idleRaw = live.totalSupplyAssets - live.totalBorrowAssets
  if (borrowAssets > idleRaw) {
    return { error: `The ${m.stockSymbol} market only has ${formatUnits(idleRaw, USDG_DECIMALS)} USDG available to borrow right now. Borrow up to that amount, or try again later.` }
  }

  // New collateral to post: explicit amount, or the full wallet balance (more
  // collateral = lower LTV = safer; the user can name a smaller amount).
  const postRaw = collateralAmount !== undefined
    ? parseUnits(collateralAmount.replace(/,/g, ''), STOCK_DECIMALS)
    : walletBalance
  if (postRaw > walletBalance) {
    return { error: `This wallet holds ${formatUnits(walletBalance, STOCK_DECIMALS)} ${m.stockSymbol} — it can't post ${collateralAmount}.` }
  }

  const existingCollateral = pos[2]
  const totalCollateralRaw = existingCollateral + postRaw
  const totalCollateralUnits = Number(formatUnits(totalCollateralRaw, STOCK_DECIMALS))
  if (totalCollateralUnits <= 0) {
    return { error: `No ${m.stockSymbol} to use as collateral — the wallet holds none and none is already posted.` }
  }

  // Existing debt (if any) counts against the same collateral.
  const existingDebtRaw = live.totalBorrowShares === BigInt(0)
    ? BigInt(0)
    : (pos[1] * live.totalBorrowAssets) / live.totalBorrowShares
  const debtAfterUsd = Number(formatUnits(existingDebtRaw + borrowAssets, USDG_DECIMALS))

  const lltv = Number(m.params.lltv) / 1e18
  const collateralValueUsd = totalCollateralUnits * live.priceUsd
  const maxSafeDebtUsd = collateralValueUsd * lltv * BORROW_SAFETY_FRACTION
  if (debtAfterUsd > maxSafeDebtUsd) {
    return {
      error: `Too much borrow for the collateral. ${totalCollateralUnits.toFixed(6)} ${m.stockSymbol} is worth $${collateralValueUsd.toFixed(2)} at the oracle price, which safely supports about $${maxSafeDebtUsd.toFixed(2)} of total debt (${(lltv * 100).toFixed(0)}% LLTV with a safety buffer)${Number(formatUnits(existingDebtRaw, USDG_DECIMALS)) > 0 ? `, and $${formatUnits(existingDebtRaw, USDG_DECIMALS)} is already borrowed` : ''}. Borrow less or post more collateral.`,
    }
  }

  const steps: CollateralStep[] = []
  if (postRaw > BigInt(0)) {
    steps.push(step(
      `Post ${formatUnits(postRaw, STOCK_DECIMALS)} ${m.stockSymbol} as collateral`,
      encodeFunctionData({ abi: MORPHO_WRITE_ABI, functionName: 'supplyCollateral', args: [m.params, postRaw, user as `0x${string}`, '0x'] }),
      live.gasPrice,
    ))
  }
  steps.push(step(
    `Borrow ${formatUnits(borrowAssets, USDG_DECIMALS)} USDG`,
    // Receiver is always the user themselves — never a third address.
    encodeFunctionData({ abi: MORPHO_WRITE_ABI, functionName: 'borrow', args: [m.params, borrowAssets, BigInt(0), user as `0x${string}`, user as `0x${string}`] }),
    live.gasPrice,
  ))

  const marketData = (await getStockCollateralMarketData()).find((d) => d.stockSymbol === m.stockSymbol)

  return {
    kind: 'stock-borrow',
    stockSymbol: m.stockSymbol,
    steps,
    approval: postRaw > BigInt(0)
      ? { tokenAddress: m.params.collateralToken, tokenSymbol: m.stockSymbol, tokenDecimals: STOCK_DECIMALS, amountRaw: postRaw.toString(), spender: MORPHO_CORE }
      : null,
    collateralDelta: formatUnits(postRaw, STOCK_DECIMALS),
    usdgAmount: formatUnits(borrowAssets, USDG_DECIMALS),
    borrowApyPct: marketData?.borrowApyPct ?? 0,
    oraclePriceUsd: live.priceUsd,
    ltvUtilizationAfterPct: (debtAfterUsd / (collateralValueUsd * lltv)) * 100,
    liquidationPriceUsdAfter: debtAfterUsd / (totalCollateralUnits * lltv),
    debtAfterUsd,
  }
}

export async function buildStockRepay(
  user: string,
  stockSymbol: string,
  repayUsd: string | 'all',
): Promise<{ error: string } | StockCollateralQuote> {
  const m = await getMarketBySymbol(stockSymbol)
  if (!m) return { error: `No Morpho collateral market exists for ${stockSymbol.toUpperCase()}.` }

  const [live, pos] = await Promise.all([
    readLiveMarket(m),
    rpcClient.readContract({ address: MORPHO_CORE, abi: MORPHO_VIEW_ABI, functionName: 'position', args: [m.id, user as `0x${string}`] }),
  ])
  const borrowShares = pos[1]
  const collateralRaw = pos[2]
  const debtRaw = live.totalBorrowShares === BigInt(0)
    ? BigInt(0)
    : (borrowShares * live.totalBorrowAssets) / live.totalBorrowShares
  const debtUsd = Number(formatUnits(debtRaw, USDG_DECIMALS))

  // No debt: "repay" means getting the posted collateral back out.
  if (debtRaw === BigInt(0)) {
    if (collateralRaw === BigInt(0)) return { error: `This wallet has no debt and no collateral in the ${m.stockSymbol} market — nothing to repay or withdraw.` }
    return {
      kind: 'stock-repay',
      stockSymbol: m.stockSymbol,
      steps: [step(
        `Withdraw ${formatUnits(collateralRaw, STOCK_DECIMALS)} ${m.stockSymbol} collateral back to the wallet`,
        encodeFunctionData({ abi: MORPHO_WRITE_ABI, functionName: 'withdrawCollateral', args: [m.params, collateralRaw, user as `0x${string}`, user as `0x${string}`] }),
        live.gasPrice,
      )],
      approval: null,
      collateralDelta: formatUnits(collateralRaw, STOCK_DECIMALS),
      usdgAmount: '0',
      borrowApyPct: 0,
      oraclePriceUsd: live.priceUsd,
      ltvUtilizationAfterPct: 0,
      liquidationPriceUsdAfter: null,
      debtAfterUsd: 0,
    }
  }

  const isFullRepay = repayUsd === 'all'
  const steps: CollateralStep[] = []
  let approvalRaw: bigint
  let repaidUsdStr: string

  if (isFullRepay) {
    // Repaying by SHARES clears the debt exactly even as interest accrues between
    // quote and signing — an assets-denominated "full" repay would leave dust or
    // revert. The approval carries a 1% buffer for that same accrual; only the
    // real debt is pulled.
    approvalRaw = (debtRaw * BigInt(101)) / BigInt(100)
    repaidUsdStr = formatUnits(debtRaw, USDG_DECIMALS)
    steps.push(step(
      `Repay the full ${repaidUsdStr} USDG debt`,
      encodeFunctionData({ abi: MORPHO_WRITE_ABI, functionName: 'repay', args: [m.params, BigInt(0), borrowShares, user as `0x${string}`, '0x'] }),
      live.gasPrice,
    ))
    if (collateralRaw > BigInt(0)) {
      steps.push(step(
        `Withdraw ${formatUnits(collateralRaw, STOCK_DECIMALS)} ${m.stockSymbol} collateral back to the wallet`,
        encodeFunctionData({ abi: MORPHO_WRITE_ABI, functionName: 'withdrawCollateral', args: [m.params, collateralRaw, user as `0x${string}`, user as `0x${string}`] }),
        live.gasPrice,
      ))
    }
  } else {
    const repayAssets = parseUnits(repayUsd.replace(/,/g, ''), USDG_DECIMALS)
    if (repayAssets <= BigInt(0)) return { error: 'Repay amount must be greater than zero.' }
    if (repayAssets >= debtRaw) {
      return { error: `The debt is ${debtUsd.toFixed(4)} USDG — repaying ${repayUsd} would overpay. Say "repay all" to close the position exactly (interest accrues by the second, so a fixed number can't).` }
    }
    approvalRaw = repayAssets
    repaidUsdStr = formatUnits(repayAssets, USDG_DECIMALS)
    steps.push(step(
      `Repay ${repaidUsdStr} USDG of the debt`,
      encodeFunctionData({ abi: MORPHO_WRITE_ABI, functionName: 'repay', args: [m.params, repayAssets, BigInt(0), user as `0x${string}`, '0x'] }),
      live.gasPrice,
    ))
  }

  const usdgBalance = await rpcClient.readContract({ address: m.params.loanToken, abi: erc20Abi, functionName: 'balanceOf', args: [user as `0x${string}`] })
  if (usdgBalance < approvalRaw) {
    return { error: `Repaying needs about ${formatUnits(approvalRaw, USDG_DECIMALS)} USDG but this wallet only holds ${formatUnits(usdgBalance, USDG_DECIMALS)} USDG. Top up USDG first (e.g. sell a little stock).` }
  }

  const debtAfterRaw = isFullRepay ? BigInt(0) : debtRaw - parseUnits(repayUsd.replace(/,/g, ''), USDG_DECIMALS)
  const debtAfterUsd = Number(formatUnits(debtAfterRaw, USDG_DECIMALS))
  const collateralUnits = Number(formatUnits(collateralRaw, STOCK_DECIMALS))
  const lltv = Number(m.params.lltv) / 1e18
  const collateralAfterUnits = isFullRepay ? 0 : collateralUnits

  return {
    kind: 'stock-repay',
    stockSymbol: m.stockSymbol,
    steps,
    approval: { tokenAddress: m.params.loanToken, tokenSymbol: 'USDG', tokenDecimals: USDG_DECIMALS, amountRaw: approvalRaw.toString(), spender: MORPHO_CORE },
    collateralDelta: isFullRepay ? formatUnits(collateralRaw, STOCK_DECIMALS) : '0',
    usdgAmount: repaidUsdStr,
    borrowApyPct: 0,
    oraclePriceUsd: live.priceUsd,
    ltvUtilizationAfterPct: collateralAfterUnits > 0 && debtAfterUsd > 0
      ? (debtAfterUsd / (collateralAfterUnits * live.priceUsd * lltv)) * 100
      : 0,
    liquidationPriceUsdAfter: collateralAfterUnits > 0 && debtAfterUsd > 0
      ? debtAfterUsd / (collateralAfterUnits * lltv)
      : null,
    debtAfterUsd,
  }
}
