import { type Hash, type WalletClient, type PublicClient, erc20Abi, parseUnits, encodeFunctionData } from 'viem'
import { NATIVE_ETH_ADDRESS } from './get-swap-quote'
import { resolveSendGasPrice } from './gas'

export type ExecuteSwapParams = {
  walletClient: WalletClient
  publicClient: PublicClient
  amount: string
  sellTokenAddress: string
  sellTokenDecimals: number
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
  amount,
  sellTokenAddress,
  sellTokenDecimals,
  transaction,
}: ExecuteSwapParams): Promise<{ txHash: Hash; error?: string }> {
  try {
    const [account] = await walletClient.getAddresses()

    if (!account) {
      return { txHash: '0x' as Hash, error: 'No wallet connected' }
    }

    // Selling an ERC-20 through the 0x AllowanceHolder router requires the router to
    // already be approved to pull the sell token — unlike native ETH, which is wrapped
    // inline and needs no approval. Without this, the swap transaction reverts on-chain,
    // or a wallet's own pre-flight simulation refuses to let the user sign it at all
    // (Seen in prod: a NOCK sale with plenty of ETH for gas showed a disabled
    // "Deposit ETH" button, because the wallet couldn't simulate a transferFrom with zero
    // allowance). Only approve the exact amount being sold, not unlimited, matching the
    // least-privilege approach used everywhere else in this app.
    if (sellTokenAddress.toLowerCase() !== NATIVE_ETH_ADDRESS.toLowerCase()) {
      const sellAmountWei = parseUnits(amount.replace(/,/g, ''), sellTokenDecimals)
      const currentAllowance = await publicClient.readContract({
        address: sellTokenAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, transaction.to as `0x${string}`],
      })

      if (currentAllowance < sellAmountWei) {
        const approveData = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [transaction.to as `0x${string}`, sellAmountWei],
        })
        const approveHash = await walletClient.sendTransaction({
          account,
          chain: walletClient.chain,
          to: sellTokenAddress as `0x${string}`,
          data: approveData,
        })
        const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
        if (approveReceipt.status !== 'success') {
          return { txHash: approveHash, error: 'Approval transaction failed on-chain — the swap was not attempted.' }
        }
      }
    }

    const txHash = await walletClient.sendTransaction({
      account,
      chain: walletClient.chain,
      to: transaction.to as `0x${string}`,
      data: transaction.data as `0x${string}`,
      gas: BigInt(transaction.gas),
      gasPrice: await resolveSendGasPrice(publicClient, transaction.gasPrice),
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
