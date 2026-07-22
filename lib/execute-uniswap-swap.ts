import { cleanTxError } from './tx-error'
import { type Hash, type WalletClient, type PublicClient, erc20Abi, parseUnits, encodeFunctionData } from 'viem'
import { UNISWAP_V4 } from './get-uniswap-quote'
import { resolveSendGasPrice } from './gas'
import { supportsAtomicBatch, sendAtomicBatch, type BatchCall } from './eip5792'

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

    // One-time (max) approvals so repeat stock trades of this token need NO re-approval —
    // just the swap (per the user's chosen approvals setting). Permit2 + the Universal
    // Router are audited. MAX for the ERC-20 approval; max uint160 + a far expiry for the
    // Permit2 allowance (its amount field is uint160, expiration uint48).
    const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1)
    const MAX_UINT160 = (BigInt(1) << BigInt(160)) - BigInt(1)

    // Which of the two approval steps are actually needed for this trade.
    // Step 1: the token itself must allow Permit2 to move it.
    const erc20Allowance = await publicClient.readContract({
      address: token, abi: erc20Abi, functionName: 'allowance', args: [account, permit2],
    })
    const needErc20Approval = erc20Allowance < sellAmount
    // Step 2: Permit2 must allow the Universal Router to spend that token for this
    // wallet, and the allowance must not be expired.
    const [p2Amount, p2Expiration] = await publicClient.readContract({
      address: permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account, token, router],
    })
    const nowSec = Math.floor(Date.now() / 1000)
    const needPermit2Approval = p2Amount < sellAmount || p2Expiration <= nowSec + 3600
    // Long expiry (~10y) so it doesn't lapse and re-prompt. PERMIT2_EXPIRATION_SECONDS is
    // the previous short window; use a large one here for the one-time UX.
    const permit2Expiration = nowSec + 315_360_000

    const erc20ApproveData = encodeFunctionData({
      abi: erc20Abi, functionName: 'approve', args: [permit2, MAX_UINT256],
    })
    const permit2ApproveData = encodeFunctionData({
      abi: PERMIT2_ABI, functionName: 'approve', args: [token, router, MAX_UINT160, permit2Expiration],
    })

    // If the wallet runs as a smart account (EIP-5792), bundle whatever approvals are
    // needed PLUS the swap into ONE user confirmation — so even a first-ever stock trade
    // is a single tap instead of up to three. Standard EOAs fall through to the
    // sequential steps below, which behave exactly as before.
    const chainId = walletClient.chain?.id
    if ((needErc20Approval || needPermit2Approval) && chainId && (await supportsAtomicBatch(walletClient, account, chainId))) {
      try {
        const calls: BatchCall[] = []
        if (needErc20Approval) calls.push({ to: token, data: erc20ApproveData })
        if (needPermit2Approval) calls.push({ to: permit2, data: permit2ApproveData })
        calls.push({ to: router, data: transaction.data as `0x${string}`, value: BigInt(transaction.value || '0') })
        const batched = await sendAtomicBatch(walletClient, { account, chain: walletClient.chain, calls })
        return { txHash: (batched.txHash ?? ('0x' as Hash)), error: batched.error }
      } catch (batchErr) {
        // Advertised batching but the bundle errored (e.g. user declined a one-time
        // smart-account upgrade). Fall through to the sequential steps below.
        console.warn('[execute-uniswap-swap] atomic batch unavailable, using sequential flow:', batchErr)
      }
    }

    // Sequential fallback (standard wallet): approve step 1, then step 2, then swap.
    if (needErc20Approval) {
      const approveHash = await walletClient.sendTransaction({
        account, chain: walletClient.chain, to: token, data: erc20ApproveData,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
      if (receipt.status !== 'success') {
        return { txHash: approveHash, error: 'Token approval to Permit2 failed on-chain — the trade was not attempted.' }
      }
    }
    if (needPermit2Approval) {
      const permitHash = await walletClient.sendTransaction({
        account, chain: walletClient.chain, to: permit2, data: permit2ApproveData,
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
