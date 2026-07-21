import { cleanTxError } from './tx-error'
import { type Hash, type WalletClient, type PublicClient, erc20Abi, parseUnits } from 'viem'
import { UNISWAP_V4 } from './get-uniswap-quote'
import { resolveSendGasPrice } from './gas'

// Executes a stock-token trade through the Uniswap Universal Router. Unlike the 0x
// router (which pulls tokens via a direct ERC20 allowance), the Universal Router
// settles ERC20 inputs through Permit2 — so a first-time trade can take up to three
// wallet confirmations: token approval to Permit2, Permit2 allowance to the router,
// then the swap itself. Mirrors executeSwap's signature and return shape exactly so
// the downstream pipeline (audit log -> independent verify -> UI) works unchanged.

const PERMIT2_ABI = [
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    outputs: [
      { type: 'uint160', name: 'amount' },
      { type: 'uint48', name: 'expiration' },
      { type: 'uint48', name: 'nonce' },
    ],
  },
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'token' },
      { type: 'address', name: 'spender' },
      { type: 'uint160', name: 'amount' },
      { type: 'uint48', name: 'expiration' },
    ],
    outputs: [],
  },
] as const

const PERMIT2_EXPIRATION_SECONDS = 30 * 60

export type ExecuteUniswapSwapParams = {
  walletClient: WalletClient
  publicClient: PublicClient
  amount: string
  sellTokenAddress: string
  sellTokenDecimals: number
  sellAmountRaw?: string // exact sell-side wei; preferred over parseUnits(amount) for approval
  transaction: {
    to: string
    data: string
    gas: string
    gasPrice: string
    value: string
  }
}

export async function executeUniswapV4Swap({
  walletClient,
  publicClient,
  amount,
  sellTokenAddress,
  sellTokenDecimals,
  sellAmountRaw,
  transaction,
}: ExecuteUniswapSwapParams): Promise<{ txHash: Hash; error?: string }> {
  try {
    const [account] = await walletClient.getAddresses()
    if (!account) {
      return { txHash: '0x' as Hash, error: 'No wallet connected' }
    }

    // Exact wei from the quote when available — parsing the rounded display `amount` can
    // round UP past the wallet balance on a full-balance sell, failing the approve/pull.
    const sellAmount = sellAmountRaw ? BigInt(sellAmountRaw) : parseUnits(amount.replace(/,/g, ''), sellTokenDecimals)
    const permit2 = UNISWAP_V4.permit2 as `0x${string}`
    const router = transaction.to as `0x${string}`
    const token = sellTokenAddress as `0x${string}`

    // Step 1: the token itself must allow Permit2 to move it. Exact amount, matching
    // the least-privilege approach used for 0x swaps.
    const erc20Allowance = await publicClient.readContract({
      address: token, abi: erc20Abi, functionName: 'allowance', args: [account, permit2],
    })
    if (erc20Allowance < sellAmount) {
      const approveHash = await walletClient.writeContract({
        address: token, abi: erc20Abi, functionName: 'approve',
        args: [permit2, sellAmount],
        account, chain: walletClient.chain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
      if (receipt.status !== 'success') {
        return { txHash: approveHash, error: 'Token approval to Permit2 failed on-chain — the trade was not attempted.' }
      }
    }

    // Step 2: Permit2 must allow the Universal Router to spend that token for this
    // wallet, and the allowance must not be expired.
    const [p2Amount, p2Expiration] = await publicClient.readContract({
      address: permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account, token, router],
    })
    const nowSec = Math.floor(Date.now() / 1000)
    if (p2Amount < sellAmount || p2Expiration <= nowSec) {
      const expiration = nowSec + PERMIT2_EXPIRATION_SECONDS
      const permitHash = await walletClient.writeContract({
        address: permit2, abi: PERMIT2_ABI, functionName: 'approve',
        args: [token, router, sellAmount, expiration],
        account, chain: walletClient.chain,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash: permitHash })
      if (receipt.status !== 'success') {
        return { txHash: permitHash, error: 'Permit2 authorization failed on-chain — the trade was not attempted.' }
      }
    }

    // Step 3: the swap.
    const txHash = await walletClient.sendTransaction({
      account,
      chain: walletClient.chain,
      to: router,
      data: transaction.data as `0x${string}`,
      gas: BigInt(transaction.gas),
      gasPrice: await resolveSendGasPrice(publicClient, transaction.gasPrice),
      value: BigInt(transaction.value || '0'),
    })

    // Broadcast is not success — the swap can still revert (e.g. the quote's slippage
    // floor was breached while waiting for the wallet). Same rule as every other
    // execution path here: wait for the real receipt.
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      return {
        txHash,
        error: 'Trade reverted on-chain — nothing was traded (funds are safe, only gas was spent). Usually the price moved past the slippage protection. Try again for a fresh quote.',
      }
    }

    return { txHash }
  } catch (error) {
    const message = cleanTxError(error)
    return { txHash: '0x' as Hash, error: message }
  }
}
