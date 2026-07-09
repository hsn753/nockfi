import { parseUnits, formatUnits } from 'viem'

const ZEROX_BASE = 'https://api.0x.org'
const CHAIN_ID = 46630

export const SWAP_TOKENS: Record<string, { address: string; decimals: number }> = {
  USDG: { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
  TSLA: { address: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E', decimals: 18 },
  AMD:  { address: '0x71178BAc73cBeb415514eB542a8995b82669778d', decimals: 18 },
  AMZN: { address: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02', decimals: 18 },
  NFLX: { address: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93', decimals: 18 },
  PLTR: { address: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0', decimals: 18 },
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

  const sell = SWAP_TOKENS[fromToken.toUpperCase()]
  const buy = SWAP_TOKENS[toToken.toUpperCase()]

  if (!sell) return { ...baseResult(fromToken, toToken, amount), error: `Token not supported: ${fromToken}` }
  if (!buy)  return { ...baseResult(fromToken, toToken, amount), error: `Token not supported: ${toToken}` }

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
    fromSymbol: fromToken.toUpperCase(),
    toSymbol: toToken.toUpperCase(),
    fromAmount: fromAmt.toLocaleString('en-US', { maximumFractionDigits: 6 }),
    toAmount: toAmt.toLocaleString('en-US', { maximumFractionDigits: 6 }),
    exchangeRate: `1 ${fromToken.toUpperCase()} = ${rateStr} ${toToken.toUpperCase()}`,
    liquidityAvailable: true,
    transaction: data.transaction ?? null,
  }
}
