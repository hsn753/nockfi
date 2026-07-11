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

// Robinhood's stock/ETF tokens are deliberately not listed here — Nock isn't offering
// regulated-security trading right now, only native crypto, USDG, and memecoins.
export const SWAP_TOKENS: Record<string, { address: string; decimals: number }> = {
  ETH:  { address: NATIVE_ETH_ADDRESS, decimals: 18 },
  WETH: { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', decimals: 18 },
  USDG: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
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
  // The resolved sell-side token's address/decimals, so the executor can check and
  // (if needed) grant the router an allowance before sending the swap — selling any
  // ERC-20 other than native ETH through AllowanceHolder requires this, and without it
  // the swap transaction just reverts (or a wallet UI refuses to even simulate it).
  sellTokenAddress?: string
  sellTokenDecimals?: number
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
    sellTokenAddress: sell.address,
    sellTokenDecimals: sell.decimals,
  }
}
