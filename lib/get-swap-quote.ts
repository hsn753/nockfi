import { parseUnits, formatUnits, createPublicClient, http, erc20Abi, isAddress } from 'viem'
import { nockChain } from './chain'

const ZEROX_BASE = 'https://api.0x.org'
const CHAIN_ID = 4663

// Verified against https://docs.robinhood.com/chain/contracts/ (Robinhood Chain MAINNET, id 4663).
// The previous addresses here were Robinhood Chain testnet addresses with no code on mainnet,
// which is why every quote for these tokens returned no liquidity.
// ETH uses the standard 0xEeee...EEeE pseudo-address 0x/1inch/etc. use for the native token —
// it's not an ERC-20 contract, 0x's API special-cases it.
export const NATIVE_ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

export const SWAP_TOKENS: Record<string, { address: string; decimals: number }> = {
  ETH:  { address: NATIVE_ETH_ADDRESS, decimals: 18 },
  WETH: { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', decimals: 18 },
  USDG: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
  TSLA: { address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', decimals: 18 },
  AMD:  { address: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC', decimals: 18 },
  AMZN: { address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54', decimals: 18 },
  AAPL: { address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', decimals: 18 },
  PLTR: { address: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A', decimals: 18 },
  BABA: { address: '0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4', decimals: 18 },
  BE:   { address: '0x822CC93fFD030293E9842c30BBD678F530701867', decimals: 18 },
  COIN: { address: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b', decimals: 18 },
  CRCL: { address: '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5', decimals: 18 },
  CRWV: { address: '0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3', decimals: 18 },
  GOOGL:{ address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', decimals: 18 },
  INTC: { address: '0xc72b96e0E48ecd4DC75E1e45396e26300BC39681', decimals: 18 },
  META: { address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', decimals: 18 },
  MSFT: { address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74', decimals: 18 },
  MU:   { address: '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD', decimals: 18 },
  NVDA: { address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18 },
  ORCL: { address: '0xb0992820E760d836549ba69BC7598b4af75dEE03', decimals: 18 },
  SNDK: { address: '0xB90A19fF0Af67f7779afF50A882A9CfF42446400', decimals: 18 },
  SPCX: { address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', decimals: 18 },
  USAR: { address: '0xd917B029C761D264c6A312BBbcDA868658eF86a6', decimals: 18 },
  QQQ:  { address: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68', decimals: 18 },
  SGOV: { address: '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5', decimals: 18 },
  SLV:  { address: '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f', decimals: 18 },
  SPY:  { address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', decimals: 18 },
  CUSO: { address: '0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344', decimals: 18 },
}

export type SwapQuoteResult = {
  fromSymbol: string
  toSymbol: string
  fromAmount: string
  toAmount: string
  exchangeRate: string
  liquidityAvailable: boolean
  transaction: {
    to: string
    data: string
    gas: string
    gasPrice: string
    value: string
  } | null
  error?: string
  // False when either side of the trade is a raw contract address rather than one of
  // Robinhood's own verified tokens — i.e. any memecoin/community token. The caller
  // must treat this as "not vetted, real scam risk" and say so to the user.
  verified?: boolean
}

const decimalsCache = new Map<string, number>()
const rpcClient = createPublicClient({ chain: nockChain, transport: http(process.env.RPC_URL) })

async function resolveToken(input: string): Promise<{ address: string; decimals: number; verified: boolean } | null> {
  const known = SWAP_TOKENS[input.toUpperCase()]
  if (known) return { ...known, verified: true }

  if (!isAddress(input)) return null
  const cached = decimalsCache.get(input.toLowerCase())
  if (cached !== undefined) return { address: input, decimals: cached, verified: false }

  try {
    const decimals = await rpcClient.readContract({ address: input as `0x${string}`, abi: erc20Abi, functionName: 'decimals' })
    decimalsCache.set(input.toLowerCase(), decimals)
    return { address: input, decimals, verified: false }
  } catch {
    return null
  }
}

type ZeroXQuoteResponse = {
  sellAmount: string
  buyAmount: string
  grossSellAmount?: string
  grossBuyAmount?: string
  liquidityAvailable: boolean
  transaction?: {
    to: string
    data: string
    gas: string
    gasPrice: string
    value: string
  }
}

function baseResult(fromToken: string, toToken: string, amount: string): SwapQuoteResult {
  return {
    fromSymbol: fromToken.toUpperCase(),
    toSymbol: toToken.toUpperCase(),
    fromAmount: amount,
    toAmount: '0',
    exchangeRate: 'N/A',
    liquidityAvailable: false,
    transaction: null,
  }
}

export async function fetchSwapQuote({
  fromToken,
  toToken,
  amount,
  taker,
}: {
  fromToken: string
  toToken: string
  amount: string
  taker?: string
}): Promise<SwapQuoteResult> {
  const apiKey = process.env.ZEROX_API_KEY
  if (!apiKey) throw new Error('ZEROX_API_KEY not configured')

  const sell = await resolveToken(fromToken)
  const buy = await resolveToken(toToken)

  if (!sell) return { ...baseResult(fromToken, toToken, amount), error: `Could not resolve token: ${fromToken}. Use a known symbol or a valid contract address.` }
  if (!buy)  return { ...baseResult(fromToken, toToken, amount), error: `Could not resolve token: ${toToken}. Use a known symbol or a valid contract address.` }

  const bothVerified = sell.verified && buy.verified

  let sellAmountWei: string
  try {
    sellAmountWei = parseUnits(amount, sell.decimals).toString()
  } catch {
    return { ...baseResult(fromToken, toToken, amount), error: `Invalid amount: ${amount}` }
  }

  const params = new URLSearchParams({
    chainId: String(CHAIN_ID),
    sellToken: sell.address,
    buyToken: buy.address,
    sellAmount: sellAmountWei,
    ...(taker ? { taker } : {}),
  })

  let res: Response
  try {
    res = await fetch(`${ZEROX_BASE}/swap/allowance-holder/quote?${params}`, {
      headers: {
        '0x-api-key': apiKey,
        '0x-version': 'v2',
      },
    })
  } catch (err) {
    return { ...baseResult(fromToken, toToken, amount), error: `Network error reaching 0x API: ${String(err)}` }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { reason?: string; validationErrors?: { reason: string }[] }
    console.error('[get-swap-quote] 0x API non-OK response:', res.status, JSON.stringify(body))
    const message =
      body?.validationErrors?.[0]?.reason ??
      body?.reason ??
      `0x API returned ${res.status}`
    return { ...baseResult(fromToken, toToken, amount), error: message }
  }

  const data = (await res.json()) as ZeroXQuoteResponse

  if (!data.liquidityAvailable) {
    return { ...baseResult(fromToken, toToken, amount), error: 'No liquidity available for this pair right now.' }
  }

  const rawSell = data.grossSellAmount ?? data.sellAmount
  const rawBuy  = data.grossBuyAmount  ?? data.buyAmount

  const fromAmt = parseFloat(formatUnits(BigInt(rawSell), sell.decimals))
  const toAmt   = parseFloat(formatUnits(BigInt(rawBuy),  buy.decimals))

  const rate = fromAmt > 0 ? toAmt / fromAmt : 0
  const rateStr = rate.toLocaleString('en-US', { maximumFractionDigits: 6, minimumFractionDigits: 4 })

  return {
    fromSymbol: sell.verified ? fromToken.toUpperCase() : sell.address,
    toSymbol: buy.verified ? toToken.toUpperCase() : buy.address,
    fromAmount: fromAmt.toLocaleString('en-US', { maximumFractionDigits: 6 }),
    toAmount: toAmt.toLocaleString('en-US', { maximumFractionDigits: 6 }),
    exchangeRate: `1 ${fromToken.toUpperCase()} = ${rateStr} ${toToken.toUpperCase()}`,
    liquidityAvailable: true,
    transaction: data.transaction ?? null,
    verified: bothVerified,
  }
}
