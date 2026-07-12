import { createPublicClient, http, formatUnits, parseUnits, encodeFunctionData } from 'viem'
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
  { type: 'function', name: 'maxDeposit', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'previewDeposit', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ type: 'uint256', name: 'assets' }, { type: 'address', name: 'receiver' }], outputs: [{ type: 'uint256' }] },
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

export type YieldDepositQuote = {
  transaction: { to: string; data: string; value: string; gas: string; gasPrice: string }
  assetAddress: string
  assetDecimals: number
  vaultSymbol: string
  sharesPreview: string
  amount: string
}

// A live estimateGas() call would revert here since no token approval exists yet at
// quote time (approval only happens right before the actual deposit tx, same order
// as the swap flow) — so this uses a fixed conservative limit instead, matching the
// existing '300000' fallback already used for delegated execution in
// app/api/execute-delegated-swap/route.ts.
const DEPOSIT_GAS_LIMIT = '300000'

// Checks live on-chain whether this vault is actually accepting a deposit of this
// size for this receiver (maxDeposit) before building anything — confirmed live that
// maxDeposit() currently returns 0 for every address tested, meaning Robinhood's real
// Earn product likely gates deposits through its own app rather than the raw vault
// contract. Returns an honest error in that case rather than a transaction that would
// revert; starts working automatically the moment (if ever) that changes, with no
// code change needed.
export async function buildYieldDeposit(
  receiver: string,
  amount: string,
): Promise<{ error: string } | YieldDepositQuote> {
  const cleanAmount = amount.replace(/,/g, '')
  const assets = parseUnits(cleanAmount, USDG_DECIMALS)

  const [assetAddress, vaultSymbol, maxDepositRaw] = await Promise.all([
    rpcClient.readContract({ address: STEAKHOUSE_USDG_VAULT, abi: ERC4626_ABI, functionName: 'asset' }),
    rpcClient.readContract({ address: STEAKHOUSE_USDG_VAULT, abi: ERC4626_ABI, functionName: 'symbol' }),
    rpcClient.readContract({ address: STEAKHOUSE_USDG_VAULT, abi: ERC4626_ABI, functionName: 'maxDeposit', args: [receiver as `0x${string}`] }),
  ])

  if (assets > maxDepositRaw) {
    return {
      error: `Deposits into this vault aren't open for this wallet right now (the vault currently reports a max deposit of ${formatUnits(maxDepositRaw, USDG_DECIMALS)} USDG for this address). Robinhood's Earn product appears to gate deposits through its own app rather than allowing any wallet to deposit directly into the vault contract. This may open up later — there's nothing wrong with the request itself.`,
    }
  }

  const sharesPreviewRaw = await rpcClient.readContract({
    address: STEAKHOUSE_USDG_VAULT,
    abi: ERC4626_ABI,
    functionName: 'previewDeposit',
    args: [assets],
  })

  const data = encodeFunctionData({
    abi: ERC4626_ABI,
    functionName: 'deposit',
    args: [assets, receiver as `0x${string}`],
  })

  const gasPrice = await rpcClient.getGasPrice()

  return {
    transaction: {
      to: STEAKHOUSE_USDG_VAULT,
      data,
      value: '0',
      gas: DEPOSIT_GAS_LIMIT,
      gasPrice: (gasPrice * BigInt(2)).toString(),
    },
    assetAddress,
    assetDecimals: USDG_DECIMALS,
    vaultSymbol,
    sharesPreview: formatUnits(sharesPreviewRaw, USDG_DECIMALS),
    amount: cleanAmount,
  }
}
