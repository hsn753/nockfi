import { type Hash, type WalletClient } from 'viem'

export type ExecuteSwapParams = {
  walletClient: WalletClient
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

    return { txHash }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { txHash: '0x' as Hash, error: message }
  }
}
