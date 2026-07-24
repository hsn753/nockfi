import { createPublicClient, http, formatUnits, parseUnits, encodeFunctionData } from 'viem'
import { nockChain } from './chain'
import { getReadClient } from './rpc'
import { cached } from './cache'

// Morpho Blue core on Robinhood Chain — found by tracing the Steakhouse vault's
// liquidityAdapter() (MorphoMarketV1AdapterV2 at 0x44abc1d6ccff2696d98890b92e2157af242179c2)
// to its morpho() address, then confirmed via Blockscout that it's the verified,
// standard "Morpho" (Morpho Blue) source. Critically, supply() there has NO access
// control (confirmed by reading the verified source directly, not assumed): unlike the
// Steakhouse vault wrapper (maxDeposit()==0, gated by Robinhood's own product), anyone
// can lend USDG into the underlying markets permissionlessly — that's Morpho Blue's
// core design.
export const MORPHO_CORE = '0x9d53d5e3bd5e8d4cbfa6db1ca238aea02e651010' as const

const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const
const USDG_DECIMALS = 6

export type MorphoMarketKey = 'USDe' | 'syrupUSDG' | 'spUSDG'

type MarketParams = {
  loanToken: `0x${string}`
  collateralToken: `0x${string}`
  oracle: `0x${string}`
  irm: `0x${string}`
  lltv: bigint
}

// The exact three markets the Robinhood Earn (Steakhouse) vault itself supplies into —
// confirmed on-chain via the vault adapter's nonzero position(id, adapter) in each.
// All params are immutable once a market is created (Morpho Blue design), so
// hardcoding the values read from the CreateMarket logs is safe.
export const MORPHO_MARKETS: Record<MorphoMarketKey, {
  id: `0x${string}`
  params: MarketParams
  collateralSymbol: string
  collateralDescription: string
}> = {
  USDe: {
    id: '0xc845da65a020ddca5f132efa8fea79676d8edfdea504226a4c01e7a9e34cddd6',
    params: {
      loanToken: USDG_ADDRESS,
      collateralToken: '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34',
      oracle: '0xe64849bd4ad03dfabbe02bb521de19997a19055f',
      irm: '0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1',
      lltv: BigInt('915000000000000000'),
    },
    collateralSymbol: 'USDe',
    collateralDescription: 'borrowers post Ethena USDe as collateral',
  },
  syrupUSDG: {
    id: '0x919a9b6b94dae7c86620eaf7a08e597aae8a4c3a9e9c7671771fbaf62b6b61c7',
    params: {
      loanToken: USDG_ADDRESS,
      collateralToken: '0x40858070814a57fdf33a613ae84fe0a8b4a874f7',
      oracle: '0x152c638fad68913739ee19ba8ef47faeb09dca91',
      irm: '0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1',
      lltv: BigInt('915000000000000000'),
    },
    collateralSymbol: 'syrupUSDG',
    collateralDescription: 'borrowers post Maple syrupUSDG as collateral',
  },
  spUSDG: {
    id: '0x0309c02dabf0be02682af1a2bde9a457f4df0f0b6bc889cde3f948e5315e4114',
    params: {
      loanToken: USDG_ADDRESS,
      collateralToken: '0xde770c84fe66e063336b31737cfe9790f18c4087',
      oracle: '0xe694c531f65c4babc88a52d7178476e095e51574',
      irm: '0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1',
      lltv: BigInt('915000000000000000'),
    },
    collateralSymbol: 'spUSDG',
    collateralDescription: 'borrowers post Spark spUSDG as collateral',
  },
}

const MARKET_PARAMS_ABI_COMPONENT = {
  type: 'tuple',
  components: [
    { type: 'address', name: 'loanToken' },
    { type: 'address', name: 'collateralToken' },
    { type: 'address', name: 'oracle' },
    { type: 'address', name: 'irm' },
    { type: 'uint256', name: 'lltv' },
  ],
} as const

const MORPHO_ABI = [
  {
    type: 'function', name: 'market', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [
      { type: 'uint128', name: 'totalSupplyAssets' },
      { type: 'uint128', name: 'totalSupplyShares' },
      { type: 'uint128', name: 'totalBorrowAssets' },
      { type: 'uint128', name: 'totalBorrowShares' },
      { type: 'uint128', name: 'lastUpdate' },
      { type: 'uint128', name: 'fee' },
    ],
  },
  {
    type: 'function', name: 'position', stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'address' }],
    outputs: [
      { type: 'uint256', name: 'supplyShares' },
      { type: 'uint128', name: 'borrowShares' },
      { type: 'uint128', name: 'collateral' },
    ],
  },
  {
    type: 'function', name: 'supply', stateMutability: 'nonpayable',
    inputs: [
      { ...MARKET_PARAMS_ABI_COMPONENT, name: 'marketParams' },
      { type: 'uint256', name: 'assets' },
      { type: 'uint256', name: 'shares' },
      { type: 'address', name: 'onBehalf' },
      { type: 'bytes', name: 'data' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
  },
  {
    type: 'function', name: 'withdraw', stateMutability: 'nonpayable',
    inputs: [
      { ...MARKET_PARAMS_ABI_COMPONENT, name: 'marketParams' },
      { type: 'uint256', name: 'assets' },
      { type: 'uint256', name: 'shares' },
      { type: 'address', name: 'onBehalf' },
      { type: 'address', name: 'receiver' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
  },
  // Morpho Blue's built-in delegation primitive: a user calls setAuthorization once (a
  // normal wallet tx, no session-signer infra) to let another address call
  // supply/withdraw with onBehalf = them. Used by yield automation — see
  // lib/yield-automation.ts — instead of building any custom delegated-wallet mechanism.
  // NOTE: withdraw's `receiver` above is NOT restricted on-chain to equal `onBehalf` — an
  // authorized address can send withdrawn funds anywhere. This app always hardcodes
  // receiver=user (see buildMarketWithdraw above), but that's an app-level guarantee, not
  // a protocol one: whatever key holds authorization is a genuinely sensitive secret.
  {
    type: 'function', name: 'setAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'authorized' },
      { type: 'bool', name: 'newIsAuthorized' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'isAuthorized', stateMutability: 'view',
    inputs: [
      { type: 'address', name: 'authorizer' },
      { type: 'address', name: 'authorized' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

const IRM_ABI = [
  {
    type: 'function', name: 'borrowRateView', stateMutability: 'view',
    inputs: [
      { ...MARKET_PARAMS_ABI_COMPONENT, name: 'marketParams' },
      {
        type: 'tuple', name: 'market',
        components: [
          { type: 'uint128', name: 'totalSupplyAssets' },
          { type: 'uint128', name: 'totalSupplyShares' },
          { type: 'uint128', name: 'totalBorrowAssets' },
          { type: 'uint128', name: 'totalBorrowShares' },
          { type: 'uint128', name: 'lastUpdate' },
          { type: 'uint128', name: 'fee' },
        ],
      },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

const rpcClient = getReadClient()

const SECONDS_PER_YEAR = 365 * 24 * 3600

export type MorphoMarketData = {
  key: MorphoMarketKey
  collateralSymbol: string
  collateralDescription: string
  // Live, on-chain-derived rate: IRM borrowRateView × utilization × (1 - fee),
  // compounded — never a guessed or cached number.
  supplyApyPct: number
  utilizationPct: number
  totalSuppliedUsd: number
  // supply − borrow: the real ceiling on how much can be withdrawn from this market
  // right now. High-utilization markets can have very little idle liquidity — surfaced
  // honestly rather than letting a withdrawal revert.
  availableLiquidityUsd: number
}

async function readMarketState(key: MorphoMarketKey) {
  const m = MORPHO_MARKETS[key]
  const state = await rpcClient.readContract({
    address: MORPHO_CORE, abi: MORPHO_ABI, functionName: 'market', args: [m.id],
  })
  return {
    totalSupplyAssets: state[0],
    totalSupplyShares: state[1],
    totalBorrowAssets: state[2],
    totalBorrowShares: state[3],
    lastUpdate: state[4],
    fee: state[5],
  }
}

export async function getMorphoMarketData(): Promise<MorphoMarketData[]> {
  // Market state/APY is identical for every user, so cache it briefly — collapses the
  // 60s-per-user yield poll (~12 RPC reads each) to one refresh per 30s total instead of
  // scaling RPC load with user count.
  return cached('morpho-market-data', 30_000, async () => {
  const keys = Object.keys(MORPHO_MARKETS) as MorphoMarketKey[]
  return Promise.all(keys.map(async (key) => {
    const m = MORPHO_MARKETS[key]
    const state = await readMarketState(key)
    const borrowRatePerSecond = await rpcClient.readContract({
      address: m.params.irm, abi: IRM_ABI, functionName: 'borrowRateView',
      args: [m.params, {
        totalSupplyAssets: state.totalSupplyAssets,
        totalSupplyShares: state.totalSupplyShares,
        totalBorrowAssets: state.totalBorrowAssets,
        totalBorrowShares: state.totalBorrowShares,
        lastUpdate: state.lastUpdate,
        fee: state.fee,
      }],
    })

    const supply = Number(formatUnits(state.totalSupplyAssets, USDG_DECIMALS))
    const borrow = Number(formatUnits(state.totalBorrowAssets, USDG_DECIMALS))
    const utilization = supply > 0 ? borrow / supply : 0
    const fee = Number(state.fee) / 1e18
    const borrowApr = (Number(borrowRatePerSecond) / 1e18) * SECONDS_PER_YEAR
    const supplyApr = borrowApr * utilization * (1 - fee)
    const supplyApyPct = (Math.exp(supplyApr) - 1) * 100

    return {
      key,
      collateralSymbol: m.collateralSymbol,
      collateralDescription: m.collateralDescription,
      supplyApyPct,
      utilizationPct: utilization * 100,
      totalSuppliedUsd: supply,
      availableLiquidityUsd: supply - borrow,
    }
  }))
  })
}

export type MorphoPosition = {
  market: MorphoMarketKey
  collateralSymbol: string
  suppliedUsd: number
}

export async function getUserMarketPositions(user: string): Promise<MorphoPosition[]> {
  const keys = Object.keys(MORPHO_MARKETS) as MorphoMarketKey[]
  const positions = await Promise.all(keys.map(async (key) => {
    const m = MORPHO_MARKETS[key]
    const [pos, state] = await Promise.all([
      rpcClient.readContract({ address: MORPHO_CORE, abi: MORPHO_ABI, functionName: 'position', args: [m.id, user as `0x${string}`] }),
      readMarketState(key),
    ])
    const supplyShares = pos[0]
    if (supplyShares === BigInt(0) || state.totalSupplyShares === BigInt(0)) return null
    const assets = (supplyShares * state.totalSupplyAssets) / state.totalSupplyShares
    return {
      market: key,
      collateralSymbol: m.collateralSymbol,
      suppliedUsd: Number(formatUnits(assets, USDG_DECIMALS)),
    }
  }))
  return positions.filter((p): p is MorphoPosition => p !== null)
}

// Same reasoning as lib/get-yield-data.ts's DEPOSIT_GAS_LIMIT: a live estimateGas would
// revert at quote time (no approval exists yet), so use a fixed conservative limit.
const SUPPLY_GAS_LIMIT = '400000'

export type MorphoQuote = {
  transaction: { to: string; data: string; value: string; gas: string; gasPrice: string }
  assetAddress: string
  assetDecimals: number
  market: MorphoMarketKey
  collateralSymbol: string
  direction: 'supply' | 'withdraw'
  supplyApyPct: number
  amount: string
}

export async function buildMarketSupply(
  user: string,
  amount: string,
  marketKey: MorphoMarketKey,
): Promise<{ error: string } | MorphoQuote> {
  const m = MORPHO_MARKETS[marketKey]
  if (!m) return { error: `Unknown market "${marketKey}". Valid markets: ${Object.keys(MORPHO_MARKETS).join(', ')}.` }

  const cleanAmount = amount.replace(/,/g, '')
  const assets = parseUnits(cleanAmount, USDG_DECIMALS)
  if (assets <= BigInt(0)) return { error: 'Amount must be greater than zero.' }

  const [marketData, gasPrice] = await Promise.all([
    getMorphoMarketData().then((all) => all.find((d) => d.key === marketKey)!),
    rpcClient.getGasPrice(),
  ])

  const data = encodeFunctionData({
    abi: MORPHO_ABI,
    functionName: 'supply',
    args: [m.params, assets, BigInt(0), user as `0x${string}`, '0x'],
  })

  return {
    transaction: { to: MORPHO_CORE, data, value: '0', gas: SUPPLY_GAS_LIMIT, gasPrice: (gasPrice * BigInt(2)).toString() },
    assetAddress: USDG_ADDRESS,
    assetDecimals: USDG_DECIMALS,
    market: marketKey,
    collateralSymbol: m.collateralSymbol,
    direction: 'supply',
    supplyApyPct: marketData.supplyApyPct,
    amount: cleanAmount,
  }
}

export async function buildMarketWithdraw(
  user: string,
  amount: string,
  marketKey: MorphoMarketKey,
): Promise<{ error: string } | MorphoQuote> {
  const m = MORPHO_MARKETS[marketKey]
  if (!m) return { error: `Unknown market "${marketKey}". Valid markets: ${Object.keys(MORPHO_MARKETS).join(', ')}.` }

  const cleanAmount = amount.replace(/,/g, '')
  const assets = parseUnits(cleanAmount, USDG_DECIMALS)
  if (assets <= BigInt(0)) return { error: 'Amount must be greater than zero.' }

  const [positions, state, gasPrice] = await Promise.all([
    getUserMarketPositions(user),
    readMarketState(marketKey),
    rpcClient.getGasPrice(),
  ])

  const position = positions.find((p) => p.market === marketKey)
  const requested = Number(formatUnits(assets, USDG_DECIMALS))
  if (!position) {
    return { error: `This wallet has no USDG supplied to the ${marketKey} market — there's nothing to withdraw there.` }
  }
  if (requested > position.suppliedUsd + 0.01) {
    return { error: `This wallet has ${position.suppliedUsd.toFixed(2)} USDG supplied to the ${marketKey} market — it can't withdraw ${cleanAmount}.` }
  }

  // Withdrawals are capped by the market's real idle liquidity (supplied minus
  // borrowed) — at high utilization this can be far less than the user's own position.
  // Checked here honestly rather than letting the transaction revert on-chain.
  const idle = Number(formatUnits(state.totalSupplyAssets - state.totalBorrowAssets, USDG_DECIMALS))
  if (requested > idle) {
    return {
      error: `The ${marketKey} market only has ${idle.toFixed(2)} USDG of idle liquidity available to withdraw right now (the rest is lent out to borrowers). Withdraw up to that amount, or try again later as borrowers repay.`,
    }
  }

  const data = encodeFunctionData({
    abi: MORPHO_ABI,
    functionName: 'withdraw',
    // Receiver is always the user themselves — never a third address.
    args: [m.params, assets, BigInt(0), user as `0x${string}`, user as `0x${string}`],
  })

  const marketData = (await getMorphoMarketData()).find((d) => d.key === marketKey)!

  return {
    transaction: { to: MORPHO_CORE, data, value: '0', gas: SUPPLY_GAS_LIMIT, gasPrice: (gasPrice * BigInt(2)).toString() },
    assetAddress: USDG_ADDRESS,
    assetDecimals: USDG_DECIMALS,
    market: marketKey,
    collateralSymbol: m.collateralSymbol,
    direction: 'withdraw',
    supplyApyPct: marketData.supplyApyPct,
    amount: cleanAmount,
  }
}

// Builds the user's own setAuthorization tx (signed by their own wallet, no session
// signer) that opts in/out of yield automation for `authorizedAddress`.
export function buildSetAuthorizationTx(authorizedAddress: `0x${string}`, enable: boolean) {
  const data = encodeFunctionData({
    abi: MORPHO_ABI,
    functionName: 'setAuthorization',
    args: [authorizedAddress, enable],
  })
  return { to: MORPHO_CORE, data, value: '0' }
}

// Independent on-chain check — never trust a client's claim that setAuthorization
// succeeded. Used both when a user enables automation and defensively on every cron
// sweep (a user can always revoke directly on-chain, bypassing our /disable endpoint).
export async function isAutomationAuthorized(user: string, authorizedAddress: string): Promise<boolean> {
  return rpcClient.readContract({
    address: MORPHO_CORE, abi: MORPHO_ABI, functionName: 'isAuthorized',
    args: [user as `0x${string}`, authorizedAddress as `0x${string}`],
  })
}
