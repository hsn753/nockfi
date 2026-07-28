import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { nockChain } from './chain'
import { getReadClient } from './rpc'
import { getReferencePrices } from './get-prices'
import { SWAP_TOKENS, NATIVE_ETH_ADDRESS } from './get-swap-quote'
import { getStockTokens } from './get-stock-tokens'

export type BalanceEntry = {
  symbol: string
  name: string
  amount: string
  usdValue: number | null
}

const TOKEN_NAMES: Record<string, string> = {
  WETH: 'Wrapped Ether', USDG: 'USDG', NOCK: 'Nock Finance',
}

// Same verified mainnet token set the swap agent uses (see get-swap-quote.ts), minus native ETH
// which is tracked separately via getBalance rather than an ERC-20 read.
const TOKENS = Object.entries(SWAP_TOKENS)
  .filter(([symbol, t]) => symbol !== 'ETH' && t.address.toLowerCase() !== NATIVE_ETH_ADDRESS.toLowerCase())
  .map(([symbol, t]) => ({ symbol, name: TOKEN_NAMES[symbol] || symbol, address: t.address as `0x${string}`, decimals: t.decimals }))

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
  // Shared, retry+fallback client (see lib/rpc.ts) — this is the hottest read path in the
  // app; rebuilding a client per request and having no fallback was a scale liability. The
  // client falls back to the public Robinhood RPC when RPC_URL is unset, so there's no
  // longer a hard RPC_URL requirement here.
  const client = getReadClient()

  try {
    const [ethRaw, erc20Balances, prices, stockEntries] = await Promise.all([
      client.getBalance({ address }),
      // One multicall for every tracked token's balance, not N individual round-trips —
      // decimals are already known statically (SWAP_TOKENS) so there's no need to read
      // them on-chain at all, they never change for an existing token. Fewer individual
      // RPC calls means fewer independent chances to hit a slow/rate-limited response.
      client.multicall({
        contracts: TOKENS.map(({ address: tokenAddr }) => ({
          address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf' as const, args: [address],
        })),
        allowFailure: true,
      }),
      getReferencePrices().catch((err) => {
        console.error('[get-balances] Price fetch failed:', err)
        return {} as Record<string, number>
      }),
      // Official stock-token positions. Without this, a TSLA position bought through
      // this very app was invisible to holdings — and the model, unable to answer
      // "how much TSLA do I hold", went hunting through the unverified token list
      // where same-ticker impersonators live. Best-effort: a registry/multicall
      // failure must not take down core balances.
      fetchStockBalances(client, address).catch((err) => {
        console.error('[get-balances] Stock balance fetch failed:', err)
        return [] as BalanceEntry[]
      }),
    ])

    console.log('[get-balances] Raw results received')

    return [...buildBalanceResults(ethRaw, erc20Balances, prices), ...stockEntries]
  } catch (err) {
    console.error('[get-balances] Error during fetch:', err)
    throw err
  }
}

// All ~50 verified stock tokens in one Multicall3 round-trip (registry decimals are
// uniformly 18, verified on-chain — see get-uniswap-quote.ts). Only nonzero positions
// are returned: 50 zero rows would drown the real holdings for every wallet.
async function fetchStockBalances(
  client: ReturnType<typeof createPublicClient>,
  address: `0x${string}`,
): Promise<BalanceEntry[]> {
  const stocks = await getStockTokens()
  if (stocks.length === 0) return []

  const results = await client.multicall({
    contracts: stocks.map((s) => ({
      address: s.address as `0x${string}`,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [address],
    })),
    allowFailure: true,
  })

  return stocks.flatMap((s, i) => {
    const r = results[i]
    if (r.status !== 'success') return []
    const raw = r.result as bigint
    if (raw === BigInt(0)) return []
    return [{
      symbol: s.symbol,
      name: `${s.name} (official stock token)`,
      amount: fmtBalance(raw, 18),
      usdValue: usdValueFor(raw, 18, s.priceUsd ?? undefined),
    }]
  })
}

function buildBalanceResults(
  ethRaw: bigint,
  erc20Balances: { status: string; result?: unknown }[],
  prices: Record<string, number>,
): BalanceEntry[] {
  const tokenBalances = TOKENS.map((t, i) => {
    const r = erc20Balances[i]
    const raw = (r.status === 'success' ? (r.result as bigint) : BigInt(0))
    return { symbol: t.symbol, name: t.name, amount: fmtBalance(raw, t.decimals), usdValue: usdValueFor(raw, t.decimals, prices[t.symbol]) }
  })

  return [
    { symbol: 'ETH', name: 'Ether', amount: fmtBalance(ethRaw, 18), usdValue: usdValueFor(ethRaw, 18, prices.ETH) },
    ...tokenBalances,
  ]
}

// For any token NOT in the fixed verified/tracked list above — memecoins, community tokens,
// anything the user holds that this app doesn't otherwise watch. get_wallet_holdings only
// ever checks the fixed list, so a real balance of an unlisted token (including one the user
// swapped into through this app) would otherwise never show up, and the model would have no
// real data to answer with — seen in prod this led to the model just asserting
// "0" with no tool call behind it, for a token the user's own wallet history proved they held.
export async function fetchArbitraryTokenBalance(
  walletAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
): Promise<{ amount: string; symbol: string; decimals: number }> {
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) throw new Error('RPC_URL not configured')

  const client = createPublicClient({ chain: nockChain, transport: http(rpcUrl) })
  const [raw, decimals, symbol] = await Promise.all([
    client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddress] }),
    client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' }),
    client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
  ])

  return { amount: fmtBalance(raw, decimals), symbol, decimals }
}
