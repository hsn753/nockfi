import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { nockChain } from './chain'
import { getReferencePrices } from './get-prices'
import { SWAP_TOKENS, NATIVE_ETH_ADDRESS } from './get-swap-quote'

export type BalanceEntry = {
  symbol: string
  name: string
  amount: string
  usdValue: number | null
}

const TOKEN_NAMES: Record<string, string> = {
  WETH: 'Wrapped Ether', USDG: 'USDG',
  TSLA: 'Tesla stock token', AMD: 'AMD stock token', AMZN: 'Amazon stock token',
  AAPL: 'Apple stock token', PLTR: 'Palantir stock token', BABA: 'Alibaba stock token',
  BE: 'Bloom Energy stock token', COIN: 'Coinbase stock token', CRCL: 'Circle stock token',
  CRWV: 'CoreWeave stock token', GOOGL: 'Alphabet stock token', INTC: 'Intel stock token',
  META: 'Meta stock token', MSFT: 'Microsoft stock token', MU: 'Micron stock token',
  NVDA: 'Nvidia stock token', ORCL: 'Oracle stock token', SNDK: 'SanDisk stock token',
  SPCX: 'SpaceX stock token', USAR: 'USA Rare Earth stock token', QQQ: 'Nasdaq-100 ETF token',
  SGOV: 'Short Treasury ETF token', SLV: 'Silver ETF token', SPY: 'S&P 500 ETF token',
  CUSO: 'CUSO ETF token',
}

// Same verified mainnet token set the swap agent uses (see get-swap-quote.ts), minus native ETH
// which is tracked separately via getBalance rather than an ERC-20 read.
const TOKENS = Object.entries(SWAP_TOKENS)
  .filter(([symbol, t]) => symbol !== 'ETH' && t.address.toLowerCase() !== NATIVE_ETH_ADDRESS.toLowerCase())
  .map(([symbol, t]) => ({ symbol, name: TOKEN_NAMES[symbol] || symbol, address: t.address as `0x${string}` }))

function fmtBalance(raw: bigint, decimals: number): string {
  const n = parseFloat(formatUnits(raw, decimals))
  if (n === 0) return '0'
  if (n < 0.0001) return '<0.0001'
  return n.toLocaleString('en-US', { maximumFractionDigits: 6, minimumFractionDigits: 0 })
}

function usdValueFor(raw: bigint, decimals: number, price: number | undefined): number | null {
  if (price === undefined) return null
  return parseFloat(formatUnits(raw, decimals)) * price
}

export async function fetchWalletBalances(address: `0x${string}`): Promise<BalanceEntry[]> {
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) {
    console.error('[get-balances] RPC_URL not configured')
    throw new Error('RPC_URL not configured')
  }

  console.log('[get-balances] Using RPC:', rpcUrl.substring(0, 30) + '...')
  console.log('[get-balances] Fetching balances for:', address)

  const client = createPublicClient({
    chain: nockChain,
    transport: http(rpcUrl),
  })

  try {
    const [[ethRaw, ...erc20Results], prices] = await Promise.all([
      Promise.all([
        client.getBalance({ address }),
        ...TOKENS.flatMap(({ address: tokenAddr }) => [
          client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
          client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' }),
        ]),
      ]),
      getReferencePrices().catch((err) => {
        console.error('[get-balances] Price fetch failed:', err)
        return {} as Record<string, number>
      }),
    ])

    console.log('[get-balances] Raw results received')

    return buildBalanceResults(ethRaw, erc20Results, prices)
  } catch (err) {
    console.error('[get-balances] Error during fetch:', err)
    throw err
  }
}

function buildBalanceResults(ethRaw: any, erc20Results: any[], prices: Record<string, number>): BalanceEntry[] {

  const tokenBalances = TOKENS.map((t, i) => {
    const raw = erc20Results[i * 2] as bigint
    const dec = Number(erc20Results[i * 2 + 1])
    return { symbol: t.symbol, name: t.name, amount: fmtBalance(raw, dec), usdValue: usdValueFor(raw, dec, prices[t.symbol]) }
  })

  return [
    { symbol: 'ETH', name: 'Ether', amount: fmtBalance(ethRaw as bigint, 18), usdValue: usdValueFor(ethRaw as bigint, 18, prices.ETH) },
    ...tokenBalances,
  ]
}
