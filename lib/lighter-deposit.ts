import { type Hash, type WalletClient, type PublicClient, erc20Abi, parseUnits } from 'viem'
import { cleanTxError } from './tx-error'

// Deposits USDG from the connected wallet into Lighter's escrow contract on Robinhood
// Chain — the on-chain step that both CREATES a Lighter trading account for a new L1
// address and funds it (there is no separate "create account" call; the deposit does
// both). Mirrors lib/execute-collateral.ts: exact-amount approval only if short, wait
// for each receipt, return the money-moving tx hash or a step-labeled error.
//
// Contract + mechanics were decoded from real on-chain deposits, not guessed:
//   - deposit contract is an EIP-1967 proxy, verified on Blockscout ("Escrow"), and is
//     the same address Lighter's own /info endpoint reports as contract_address.
//   - selector 0x8a857083 = deposit(address,uint16,uint8,uint256), confirmed via
//     4byte.directory. Real calls used assetId=3 (USDG) and flag=0.

const USDG_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' // 6 decimals
const LIGHTER_DEPOSIT_CONTRACT = '0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d'
const LIGHTER_USDG_ASSET_ID = 3
const USDG_DECIMALS = 6

const depositAbi = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'l1Address', type: 'address' },
      { name: 'assetId', type: 'uint16' },
      { name: 'flag', type: 'uint8' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

export type LighterDepositParams = {
  walletClient: WalletClient
  publicClient: PublicClient
  amountUsdg: string // human units, e.g. "5"
}

export async function executeLighterDeposit({
  walletClient,
  publicClient,
  amountUsdg,
}: LighterDepositParams): Promise<{ txHash: Hash; error?: string }> {
  try {
    const [account] = await walletClient.getAddresses()
    if (!account) {
      return { txHash: '0x' as Hash, error: 'No wallet connected' }
    }

    let amountRaw: bigint
    try {
      amountRaw = parseUnits(amountUsdg, USDG_DECIMALS)
    } catch {
      return { txHash: '0x' as Hash, error: 'Enter a valid USDG amount.' }
    }
    if (amountRaw <= BigInt(0)) {
      return { txHash: '0x' as Hash, error: 'Enter a positive USDG amount.' }
    }

    // Exact-amount approval, least-privilege, same as execute-collateral.ts.
    const current = await publicClient.readContract({
      address: USDG_ADDRESS,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account, LIGHTER_DEPOSIT_CONTRACT],
    })
    if (current < amountRaw) {
      const approveHash = await walletClient.writeContract({
        address: USDG_ADDRESS,
        abi: erc20Abi,
        functionName: 'approve',
        args: [LIGHTER_DEPOSIT_CONTRACT, amountRaw],
        account,
        chain: walletClient.chain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
      if (receipt.status !== 'success') {
        return { txHash: approveHash, error: 'USDG approval failed on-chain — nothing was deposited.' }
      }
    }

    const depositHash = await walletClient.writeContract({
      address: LIGHTER_DEPOSIT_CONTRACT,
      abi: depositAbi,
      functionName: 'deposit',
      args: [account, LIGHTER_USDG_ASSET_ID, 0, amountRaw],
      account,
      chain: walletClient.chain,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash })
    if (receipt.status !== 'success') {
      return { txHash: depositHash, error: 'The deposit transaction reverted on-chain. Your USDG was not deposited (aside from gas).' }
    }

    return { txHash: depositHash }
  } catch (error) {
    return { txHash: '0x' as Hash, error: cleanTxError(error) }
  }
}
