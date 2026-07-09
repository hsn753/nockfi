import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { nockChain } from './chain'

export type BalanceEntry = {
  symbol: string
  name: string
  amount: string
}

const TOKENS = [
  { symbol: 'TSLA', name: 'Tesla stock token',    address: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E' as `0x${string}` },
  { symbol: 'AMD',  name: 'AMD stock token',      address: '0x71178BAc73cBeb415514eB542a8995b82669778d' as `0x${string}` },
  { symbol: 'AMZN', name: 'Amazon stock token',   address: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02' as `0x${string}` },
  { symbol: 'NFLX', name: 'Netflix stock token',  address: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93' as `0x${string}` },
  { symbol: 'PLTR', name: 'Palantir stock token', address: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0' as `0x${string}` },
] as const

function fmtBalance(raw: bigint, decimals: number): string {
  const n = parseFloat(formatUnits(raw, decimals))
  if (n === 0) return '0'
  if (n < 0.0001) return '<0.0001'
  return n.toLocaleString('en-US', { maximumFractionDigits: 6, minimumFractionDigits: 0 })
}

export async function fetchWalletBalances(address: `0x${string}`): Promise<BalanceEntry[]> {
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) throw new Error('RPC_URL not configured')

  const client = createPublicClient({
    chain: nockChain,
    transport: http(rpcUrl),
  })

  const [ethRaw, ...erc20Results] = await Promise.all([
    client.getBalance({ address }),
    ...TOKENS.flatMap(({ address: tokenAddr }) => [
      client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
      client.readContract({ address: tokenAddr, abi: erc20Abi, functionName: 'decimals' }),
    ]),
  ])

  const tokenBalances = TOKENS.map((t, i) => {
    const raw = erc20Results[i * 2] as bigint
    const dec = Number(erc20Results[i * 2 + 1])
    return { symbol: t.symbol, name: t.name, amount: fmtBalance(raw, dec) }
  })

  return [
    { symbol: 'ETH', name: 'Ether', amount: fmtBalance(ethRaw as bigint, 18) },
    ...tokenBalances,
  ]
}
