import { erc20Abi, encodeFunctionData, formatUnits, type Hash } from 'viem'
import { nockChain } from './chain'
import { getAutomationClients, getAutomationAddress } from './yield-automation'
import { fetchSwapQuote, SWAP_TOKENS } from './get-swap-quote'

// Conditional swap execution via the ALLOWANCE model (user's choice). The user grants a
// standard ERC20 allowance to the automation key for a specific token (a normal approve()
// tx — their private key never leaves their wallet). When a strategy fires (e.g. a
// stop-loss), the automation key:
//   1. transferFrom(user -> key) the token (up to the granted allowance / balance),
//   2. swaps it to USDG via 0x (key is the taker),
//   3. transfers the USDG back to the user.
// Native ETH is unsupported (can't be approved). Every failure after step 1 tries to
// return the pulled token to the user (safety net) rather than stranding it at the key.

const USDG_ADDRESS = SWAP_TOKENS.USDG.address as `0x${string}`

export type SellToUsdgResult =
  | { status: 'executed'; soldAmount: string; usdgReceived: string; swapTxHash: Hash }
  | { status: 'not_authorized'; message: string }
  | { status: 'nothing_to_sell'; message: string }
  | { status: 'failed'; message: string }

// Sells the user's FULL balance of `tokenAddress` to USDG on a trigger, using the automation
// key + the user's pre-granted allowance. tokenDecimals/symbol for display + quoting.
export async function executeSellToUsdg(
  userAddress: string,
  tokenAddress: string,
  tokenDecimals: number,
  tokenSymbol: string,
): Promise<SellToUsdgResult> {
  const { account, walletClient, publicClient } = getAutomationClients()
  const keyAddr = getAutomationAddress()
  const token = tokenAddress as `0x${string}`

  try {
    const [balance, allowance] = await Promise.all([
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] }) as Promise<bigint>,
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [userAddress as `0x${string}`, keyAddr] }) as Promise<bigint>,
    ])
    if (balance === BigInt(0)) return { status: 'nothing_to_sell', message: `No ${tokenSymbol} balance to sell.` }
    if (allowance === BigInt(0)) {
      return { status: 'not_authorized', message: `Not authorized to sell your ${tokenSymbol} — approve the automation address for ${tokenSymbol} first.` }
    }

    // Pull what we're allowed to (min of balance and allowance).
    const pullAmount = balance < allowance ? balance : allowance

    // 1. transferFrom(user -> key).
    const tfData = encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [userAddress as `0x${string}`, keyAddr, pullAmount] })
    let pullHash: Hash
    try {
      pullHash = await walletClient.sendTransaction({ account, chain: nockChain, to: token, data: tfData, value: BigInt(0) })
    } catch (err) {
      return { status: 'failed', message: `Couldn't pull your ${tokenSymbol}: ${err instanceof Error ? err.message : 'unknown error'}` }
    }
    const pullRcpt = await publicClient.waitForTransactionReceipt({ hash: pullHash })
    if (pullRcpt.status !== 'success') return { status: 'failed', message: `The ${tokenSymbol} transfer reverted — nothing was sold.` }

    // From here the key HOLDS the token — every failure returns it to the user.
    const keyBalance = (await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [keyAddr] })) as bigint
    const bail = async (reason: string): Promise<SellToUsdgResult> => {
      const returned = await returnTokenToUser(token, userAddress, keyBalance)
      return { status: 'failed', message: `${reason}. ${returned ? `Your ${tokenSymbol} was returned to your wallet.` : `Your ${tokenSymbol} is temporarily at the automation address (${keyAddr}); needs manual follow-up, not lost.`}` }
    }

    // 2. Quote token -> USDG with the automation key as taker.
    const quote = await fetchSwapQuote({ fromToken: token, toToken: USDG_ADDRESS, amount: formatUnits(keyBalance, tokenDecimals), taker: keyAddr })
    if (!quote.transaction || !quote.liquidityAvailable) return bail(`No swap route for ${tokenSymbol} -> USDG right now`)

    // 3. Approve the 0x router for the token if needed (key's own approval).
    try {
      const routerAllowance = (await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [keyAddr, quote.transaction.to as `0x${string}`] })) as bigint
      if (routerAllowance < keyBalance) {
        const apData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [quote.transaction.to as `0x${string}`, keyBalance] })
        const apHash = await walletClient.sendTransaction({ account, chain: nockChain, to: token, data: apData, value: BigInt(0) })
        const apRcpt = await publicClient.waitForTransactionReceipt({ hash: apHash })
        if (apRcpt.status !== 'success') return bail(`The ${tokenSymbol} router approval reverted`)
      }
    } catch (err) {
      return bail(`Approving the swap failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }

    // 4. Execute the swap.
    const usdgBefore = (await publicClient.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [keyAddr] })) as bigint
    let swapHash: Hash
    try {
      swapHash = await walletClient.sendTransaction({
        account, chain: nockChain,
        to: quote.transaction.to as `0x${string}`, data: quote.transaction.data as `0x${string}`,
        value: BigInt(quote.transaction.value || '0'),
        ...(quote.transaction.gas ? { gas: BigInt(quote.transaction.gas) } : {}),
      })
    } catch (err) {
      return bail(`The swap failed to submit: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
    const swapRcpt = await publicClient.waitForTransactionReceipt({ hash: swapHash })
    if (swapRcpt.status !== 'success') return bail(`The ${tokenSymbol} -> USDG swap reverted`)

    // 5. Send the USDG proceeds to the user.
    const usdgAfter = (await publicClient.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [keyAddr] })) as bigint
    const usdgReceived = usdgAfter - usdgBefore
    if (usdgReceived > BigInt(0)) {
      const sendData = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [userAddress as `0x${string}`, usdgReceived] })
      const sendHash = await walletClient.sendTransaction({ account, chain: nockChain, to: USDG_ADDRESS, data: sendData, value: BigInt(0) })
      await publicClient.waitForTransactionReceipt({ hash: sendHash })
    }

    return { status: 'executed', soldAmount: formatUnits(keyBalance, tokenDecimals), usdgReceived: formatUnits(usdgReceived, 6), swapTxHash: swapHash }
  } catch (err) {
    console.error('[strategy-execution] executeSellToUsdg failed:', err)
    return { status: 'failed', message: err instanceof Error ? err.message : 'Unknown error' }
  }
}

async function returnTokenToUser(token: `0x${string}`, userAddress: string, amount: bigint): Promise<boolean> {
  try {
    if (amount <= BigInt(0)) return true
    const { account, walletClient, publicClient } = getAutomationClients()
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [userAddress as `0x${string}`, amount] })
    const hash = await walletClient.sendTransaction({ account, chain: nockChain, to: token, data, value: BigInt(0) })
    const rcpt = await publicClient.waitForTransactionReceipt({ hash })
    return rcpt.status === 'success'
  } catch (err) {
    console.error('[strategy-execution] returnTokenToUser failed:', err)
    return false
  }
}
