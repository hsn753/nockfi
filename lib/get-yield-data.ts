import { createPublicClient, http, formatUnits } from 'viem'
import { nockChain } from './chain'
import { getReferencePrices } from './get-prices'
import { recordSnapshot, computeApy } from './db/vault-snapshots'

// The Steakhouse USDG vault — real Morpho Vault v2 deployment on Robinhood Chain,
// curated by Steakhouse Financial, part of Robinhood's own "Earn" product. Confirmed
// directly via eth_getCode (real bytecode) and asset() (returns our own already-verified
// USDG address 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) — not assumed from docs.
// Morpho's public GraphQL API (api.morpho.org/graphql) does not index Robinhood Chain
// yet (confirmed live: a direct vaultByAddress lookup for this exact vault returns
// NOT_FOUND), so this reads the vault's real state directly on-chain instead.
export const STEAKHOUSE_USDG_VAULT = '0xBeEff033F34C046626B8D0A041844C5d1A5409dd' as const

const ERC4626_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const rpcClient = createPublicClient({ chain: nockChain, transport: http(process.env.RPC_URL) })

export type YieldVault = {
  address: string
  name: string
  symbol: string
  assetSymbol: string
  totalAssetsUsd: number
  // null until enough real snapshot history exists to compute a genuine rate — never a
  // guessed number. See lib/db/vault-snapshots.ts's computeApy.
  apy: number | null
  risk: string
  protocol: string
}

// USDG has 6 decimals — confirmed via lib/get-swap-quote.ts's SWAP_TOKENS, the same
// verified value used everywhere else in this app.
const USDG_DECIMALS = 6

export async function getYieldOptions(): Promise<YieldVault[]> {
  const [name, symbol, totalAssetsRaw, totalSupplyRaw, prices] = await Promise.all([
    rpcClient.readContract({ address: STEAKHOUSE_USDG_VAULT, abi: ERC4626_ABI, functionName: 'name' }),
    rpcClient.readContract({ address: STEAKHOUSE_USDG_VAULT, abi: ERC4626_ABI, functionName: 'symbol' }),
    rpcClient.readContract({ address: STEAKHOUSE_USDG_VAULT, abi: ERC4626_ABI, functionName: 'totalAssets' }),
    rpcClient.readContract({ address: STEAKHOUSE_USDG_VAULT, abi: ERC4626_ABI, functionName: 'totalSupply' }),
    getReferencePrices(),
  ])

  // Fire-and-forget: recording history must never block or break answering the user's
  // actual question about what's available right now.
  recordSnapshot(STEAKHOUSE_USDG_VAULT, totalAssetsRaw.toString(), totalSupplyRaw.toString()).catch((err) => {
    console.error('[get-yield-data] Could not record vault snapshot:', err)
  })

  const totalAssetsUsdg = parseFloat(formatUnits(totalAssetsRaw, USDG_DECIMALS))
  const usdgPrice = prices.USDG ?? 1
  const apy = await computeApy(STEAKHOUSE_USDG_VAULT).catch((err) => {
    console.error('[get-yield-data] Could not compute APY:', err)
    return null
  })

  return [
    {
      address: STEAKHOUSE_USDG_VAULT,
      name,
      symbol,
      assetSymbol: 'USDG',
      totalAssetsUsd: totalAssetsUsdg * usdgPrice,
      apy,
      risk: 'Low',
      protocol: 'Morpho (Steakhouse Financial curated)',
    },
  ]
}
