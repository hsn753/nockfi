import { createPublicClient, http, formatUnits, parseUnits, encodeFunctionData, encodeAbiParameters, encodePacked } from 'viem'
import { nockChain } from './chain'

// Direct Uniswap v4 integration for Robinhood's tokenized stocks. 0x (the app's
// normal swap router) refuses tokenized equities at its API layer
// (BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE), but the underlying pools are public,
// permissionless Uniswap v4 pools with real liquidity — so stock trades are quoted
// and encoded here ourselves instead of arriving pre-built from 0x.
//
// All addresses from Uniswap's official deployments page for chain 4663
// (developers.uniswap.org/contracts/v4/deployments) — NOT from a Blockscout name
// search, which surfaces three different "UniversalRouter" contracts where the
// highest-traffic one is not the official deployment. PoolManager cross-confirmed via
// the official Positions NFT's poolManager() getter; quoter confirmed pointing at it;
// quoting confirmed working end-to-end against the live TSLA/USDG pool.
export const UNISWAP_V4 = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
} as const

const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const USDG_DECIMALS = 6
const STOCK_DECIMALS = 18 // all Robinhood stock tokens use 18 (verified on-chain)

// The liquid stock pools all sit on standard fee tiers (verified against the
// PoolManager's Initialize logs + DexScreener). Plenty of same-pair pools also exist
// at absurd fee tiers (85%, 95% — sandwich traps); best-output selection below means
// they can never win a quote.
const FEE_TIERS = [
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
] as const

const POOL_KEY_COMPONENTS = [
  { type: 'address', name: 'currency0' },
  { type: 'address', name: 'currency1' },
  { type: 'uint24', name: 'fee' },
  { type: 'int24', name: 'tickSpacing' },
  { type: 'address', name: 'hooks' },
] as const

const QUOTER_ABI = [
  {
    type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
    inputs: [{
      type: 'tuple', name: 'params',
      components: [
        { type: 'tuple', name: 'poolKey', components: POOL_KEY_COMPONENTS },
        { type: 'bool', name: 'zeroForOne' },
        { type: 'uint128', name: 'exactAmount' },
        { type: 'bytes', name: 'hookData' },
      ],
    }],
    outputs: [{ type: 'uint256', name: 'amountOut' }, { type: 'uint256', name: 'gasEstimate' }],
  },
] as const

const UNIVERSAL_ROUTER_ABI = [
  {
    type: 'function', name: 'execute', stateMutability: 'payable',
    inputs: [
      { type: 'bytes', name: 'commands' },
      { type: 'bytes[]', name: 'inputs' },
      { type: 'uint256', name: 'deadline' },
    ],
    outputs: [],
  },
] as const

// Universal Router command / v4 action ids (from Uniswap's universal-router and
// v4-periphery constants).
const COMMAND_V4_SWAP = '0x10'
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06
const ACTION_SETTLE_ALL = 0x0c
const ACTION_TAKE_ALL = 0x0f

const SWAP_GAS_LIMIT = '600000'
// 0.5%. minOut is derived from the exact on-chain V4Quoter output (best.amountOut), so
// this tolerance only ever absorbs price MOVEMENT during the ~15-min quote window — not
// execution slippage, which measured ~0% on real trades up to $190 (quoted vs realized
// on-chain were identical to 6 decimals). 50 bps stays far above anything observed while
// halving worst-case adverse-movement / MEV exposure vs the old 1%.
// 2% — was 0.5%, which reverted stock SELLS on-chain: the price moves during the
// approval→sign round-trip (and sells have real price impact), blowing past a tight
// minOut. 2% absorbs that while still protecting against a bad fill.
const SLIPPAGE_BPS = BigInt(200)
const DEADLINE_SECONDS = 15 * 60

const rpcClient = createPublicClient({ chain: nockChain, transport: http(process.env.RPC_URL) })

type PoolKey = {
  currency0: `0x${string}`
  currency1: `0x${string}`
  fee: number
  tickSpacing: number
  hooks: `0x${string}`
}

function buildPoolKey(stockAddress: string, tier: { fee: number; tickSpacing: number }): { key: PoolKey; stockIsCurrency0: boolean } {
  // v4 sorts a pool's two currencies numerically — currency0 is always the lower address.
  const stockIsCurrency0 = stockAddress.toLowerCase() < USDG_ADDRESS.toLowerCase()
  return {
    key: {
      currency0: (stockIsCurrency0 ? stockAddress : USDG_ADDRESS) as `0x${string}`,
      currency1: (stockIsCurrency0 ? USDG_ADDRESS : stockAddress) as `0x${string}`,
      fee: tier.fee,
      tickSpacing: tier.tickSpacing,
      hooks: '0x0000000000000000000000000000000000000000',
    },
    stockIsCurrency0,
  }
}

export type UniswapStockQuote = {
  fromSymbol: string
  toSymbol: string
  fromAmount: string
  toAmount: string
  exchangeRate: string
  liquidityAvailable: boolean
  transaction: { to: string; data: string; value: string; gas: string; gasPrice: string } | null
  verified: boolean
  sellTokenAddress: string
  sellTokenDecimals: number
  routeVia: 'uniswap-v4'
  poolFeePct: number
  // Unix seconds after which the encoded transaction's on-chain deadline check
  // reverts. Exposed so the client can refuse a stale card BEFORE broadcasting —
  // confirming past the deadline burns gas on a guaranteed revert (seen live).
  deadlineTimestamp?: number
  error?: string
}

export async function fetchUniswapStockQuote(params: {
  stockAddress: string
  stockSymbol: string
  direction: 'buy' | 'sell'
  amount: string // USDG for buys, stock units for sells
}): Promise<UniswapStockQuote> {
  const { stockAddress, stockSymbol, direction, amount } = params
  const cleanAmount = amount.replace(/,/g, '')

  const isBuy = direction === 'buy'
  const inDecimals = isBuy ? USDG_DECIMALS : STOCK_DECIMALS
  const outDecimals = isBuy ? STOCK_DECIMALS : USDG_DECIMALS
  const amountIn = parseUnits(cleanAmount, inDecimals)

  const base: Omit<UniswapStockQuote, 'error'> = {
    fromSymbol: isBuy ? 'USDG' : stockSymbol,
    toSymbol: isBuy ? stockSymbol : 'USDG',
    fromAmount: cleanAmount,
    toAmount: '0',
    exchangeRate: 'N/A',
    liquidityAvailable: false,
    transaction: null,
    verified: true,
    sellTokenAddress: isBuy ? USDG_ADDRESS : stockAddress,
    sellTokenDecimals: inDecimals,
    routeVia: 'uniswap-v4',
    poolFeePct: 0,
  }

  if (amountIn <= BigInt(0)) return { ...base, error: 'Amount must be greater than zero.' }

  // Quote every standard fee tier and keep the best output — pools that don't exist
  // revert (skipped), and the predatory high-fee pools aren't in the candidate set.
  const candidates = await Promise.all(FEE_TIERS.map(async (tier) => {
    const { key, stockIsCurrency0 } = buildPoolKey(stockAddress, tier)
    // zeroForOne = the input currency is currency0.
    const zeroForOne = isBuy ? !stockIsCurrency0 : stockIsCurrency0
    try {
      const { result } = await rpcClient.simulateContract({
        address: UNISWAP_V4.quoter as `0x${string}`,
        abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
      })
      return { tier, key, zeroForOne, amountOut: result[0] as bigint }
    } catch {
      return null
    }
  }))

  const best = candidates
    .filter((c): c is NonNullable<typeof c> => c !== null && c.amountOut > BigInt(0))
    .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0]

  if (!best) {
    return { ...base, error: `No live Uniswap pool with liquidity found for ${stockSymbol}/USDG. This stock token may not be tradeable right now.` }
  }

  const minOut = (best.amountOut * (BigInt(10000) - SLIPPAGE_BPS)) / BigInt(10000)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS)

  const inputCurrency = best.zeroForOne ? best.key.currency0 : best.key.currency1
  const outputCurrency = best.zeroForOne ? best.key.currency1 : best.key.currency0

  // V4_SWAP payload: actions byte-string + one abi-encoded params blob per action.
  const actions = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL],
  )
  // Robinhood Chain's Universal Router is a verified FORK of Uniswap's: its
  // IV4Router.ExactInputSingleParams carries an extra `minHopPriceX36` field between
  // amountOutMinimum and hookData (per-hop price floor; 0 disables the check — see the
  // verified source on Blockscout at the router address). Encoding the standard
  // five-field struct makes the router's calldata decoder revert instantly inside
  // unlockCallback with no data — every stock trade failed this way until the field
  // was added. amountOutMinimum already enforces slippage, so 0 is correct here.
  const swapParams = encodeAbiParameters(
    [{
      type: 'tuple',
      components: [
        { type: 'tuple', name: 'poolKey', components: POOL_KEY_COMPONENTS },
        { type: 'bool', name: 'zeroForOne' },
        { type: 'uint128', name: 'amountIn' },
        { type: 'uint128', name: 'amountOutMinimum' },
        { type: 'uint256', name: 'minHopPriceX36' },
        { type: 'bytes', name: 'hookData' },
      ],
    }],
    [{ poolKey: best.key, zeroForOne: best.zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: BigInt(0), hookData: '0x' }],
  )
  const settleParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [inputCurrency, amountIn],
  )
  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [outputCurrency, minOut],
  )
  const v4SwapInput = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [swapParams, settleParams, takeParams]],
  )
  const data = encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [COMMAND_V4_SWAP, [v4SwapInput], deadline],
  })

  const gasPrice = await rpcClient.getGasPrice()

  const fromNum = parseFloat(cleanAmount)
  const toNum = parseFloat(formatUnits(best.amountOut, outDecimals))
  const rate = fromNum > 0 ? toNum / fromNum : 0

  return {
    ...base,
    toAmount: toNum.toLocaleString('en-US', { maximumFractionDigits: 6 }),
    exchangeRate: `1 ${base.fromSymbol} = ${rate.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${base.toSymbol}`,
    liquidityAvailable: true,
    transaction: {
      to: UNISWAP_V4.universalRouter,
      data,
      value: '0',
      gas: SWAP_GAS_LIMIT,
      gasPrice: (gasPrice * BigInt(2)).toString(),
    },
    poolFeePct: best.tier.fee / 10000,
    deadlineTimestamp: Number(deadline),
  }
}
