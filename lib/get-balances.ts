import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { nockChain } from './chain'
import { getReferencePrices } from './get-prices'

export type BalanceEntry = {
  symbol: string
  name: string
  amount: string
  usdValue: number | null
}

// Verified against https://docs.robinhood.com/chain/contracts/ (Robinhood Chain MAINNET, id 4663).
// The previous addresses here were Robinhood Chain testnet addresses with no code on mainnet,
// which is why every balance/quote call for these tokens was reverting.
const TOKENS = [
  { symbol: 'TSLA', name: 'Tesla stock token',    address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d' as `0x${string}` },
  { symbol: 'AMD',  name: 'AMD stock token',      address: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC' as `0x${string}` },
  { symbol: 'AMZN', name: 'Amazon stock token',   address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54' as `0x${string}` },
  { symbol: 'AAPL', name: 'Apple stock token',    address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' as `0x${string}` },
  { symbol: 'PLTR', name: 'Palantir stock token', address: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A' as `0x${string}` },
] as const

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
