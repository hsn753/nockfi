import { type Hash, type WalletClient, type PublicClient } from 'viem'

export type ExecuteSwapParams = {
  walletClient: WalletClient
  publicClient: PublicClient
  fromToken: string
  toToken: string
  amount: string
  transaction: {
    to: string
    data: string
    gas: string
    gasPrice: string
    value: string
  }
}

export async function executeSwap({
  walletClient,
  publicClient,
  transaction,
}: ExecuteSwapParams): Promise<{ txHash: Hash; error?: string }> {
  try {
    const [account] = await walletClient.getAddresses()

    if (!account) {
      return { txHash: '0x' as Hash, error: 'No wallet connected' }
    }

    const txHash = await walletClient.sendTransaction({
      account,
      chain: walletClient.chain,
      to: transaction.to as `0x${string}`,
      data: transaction.data as `0x${string}`,
      gas: BigInt(transaction.gas),
      gasPrice: BigInt(transaction.gasPrice),
      value: BigInt(transaction.value),
    })

    // The wallet broadcasting the transaction only means it was accepted into the
    // mempool — it does not mean the swap succeeded. A quote that's gone stale by the
    // time it's signed (common with wallet-approval round trips, e.g. WalletConnect)
    // can revert on-chain via 0x's minimum-output slippage protection. Without this
    // wait, a reverted transaction reads as a successful swap to the user.
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      return {
        txHash,
        error: 'Transaction reverted on-chain — nothing was swapped (funds are safe, only gas was spent). This usually means the quote went stale between preview and signing. Try again for a fresh quote.',
      }
    }

    return { txHash }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { txHash: '0x' as Hash, error: message }
  }
}
