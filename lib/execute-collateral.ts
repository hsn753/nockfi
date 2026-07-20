import { cleanTxError } from './tx-error'
import { type Hash, type WalletClient, type PublicClient, erc20Abi } from 'viem'
import type { CollateralStep } from './get-stock-collateral'
import { resolveSendGasPrice } from './gas'

// Executes a Morpho collateral action: an optional exact-amount ERC20 approval,
// then each quoted step in order (supplyCollateral -> borrow, or repay ->
// withdrawCollateral), waiting for a real on-chain receipt between steps — a later
// step must never broadcast on top of an earlier one that reverted. Returns the
// LAST step's hash as the action's tx (that's the money-moving one the audit
// pipeline logs and independently verifies), mirroring the executeSwap /
// executeUniswapV4Swap return shape.

export type ExecuteCollateralParams = {
  walletClient: WalletClient
  publicClient: PublicClient
  approval: { tokenAddress: string; amountRaw: string; spender: string } | null
  steps: CollateralStep[]
}

export async function executeCollateralSequence({
  walletClient,
  publicClient,
  approval,
  steps,
}: ExecuteCollateralParams): Promise<{ txHash: Hash; error?: string }> {
  try {
    const [account] = await walletClient.getAddresses()
    if (!account) {
      return { txHash: '0x' as Hash, error: 'No wallet connected' }
    }
    if (steps.length === 0) {
      return { txHash: '0x' as Hash, error: 'This action has no transaction steps — ask for a fresh quote.' }
    }

    // Exact-amount approval, matching the least-privilege rule used everywhere else.
    if (approval) {
      const needed = BigInt(approval.amountRaw)
      const current = await publicClient.readContract({
        address: approval.tokenAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, approval.spender as `0x${string}`],
      })
      if (current < needed) {
        const approveHash = await walletClient.writeContract({
          address: approval.tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: 'approve',
          args: [approval.spender as `0x${string}`, needed],
          account,
          chain: walletClient.chain,
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
        if (receipt.status !== 'success') {
          return { txHash: approveHash, error: 'Token approval failed on-chain — nothing else was attempted.' }
        }
      }
    }

    let lastHash: Hash = '0x' as Hash
    for (const s of steps) {
      const txHash = await walletClient.sendTransaction({
        account,
        chain: walletClient.chain,
        to: s.to as `0x${string}`,
        data: s.data as `0x${string}`,
        gas: BigInt(s.gas),
        gasPrice: await resolveSendGasPrice(publicClient, s.gasPrice),
        value: BigInt(s.value || '0'),
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
      if (receipt.status !== 'success') {
        return {
          txHash,
          error: `Step "${s.label}" reverted on-chain — later steps were not attempted (funds are safe aside from gas). ${lastHash !== '0x' ? 'Earlier steps DID complete; ask for your collateral position status to see where things stand, then ask for a fresh quote to continue.' : 'Nothing was changed. Try again with a fresh quote.'}`,
        }
      }
      lastHash = txHash
    }

    return { txHash: lastHash }
  } catch (error) {
    const message = cleanTxError(error)
    return { txHash: '0x' as Hash, error: message }
  }
}
