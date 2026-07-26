import { erc20Abi, encodeFunctionData, formatUnits, parseUnits, type Hash } from 'viem'
import { nockChain } from './chain'
import { getAutomationClients, getAutomationAddress } from './yield-automation'
import { fetchSwapQuote, SWAP_TOKENS } from './get-swap-quote'

// Conditional / rebalance swap execution via the ALLOWANCE model (user's choice). The user
// grants a standard ERC20 allowance to the automation key for a token (a normal approve()
// tx — their private key never leaves their wallet). To move funds the automation key:
//   1. transferFrom(user -> key) the sell token (up to the granted allowance),
//   2. swaps it to the buy token via 0x (key is the taker),
//   3. transfers the bought token back to the user.
// Native ETH is unsupported on the sell side (can't be approved). Every failure after
// step 1 tries to return the pulled token to the user (safety net).

const USDG_ADDRESS = SWAP_TOKENS.USDG.address as `0x${string}`

export type TokenRef = { address: string; decimals: number; symbol: string }

export type SwapForUserResult =
  | { status: 'executed'; soldAmount: string; boughtAmount: string; swapTxHash: Hash }
  | { status: 'not_authorized'; message: string }
  | { status: 'nothing_to_sell'; message: string }
  | { status: 'failed'; message: string }

// Core: swap `amountRaw` of `from` (user's) into `to`, returning the proceeds to the user.
// amountRaw is in `from`'s smallest units; omit to sell the user's FULL `from` balance
// (capped by their allowance).
export async function swapForUser(userAddress: string, from: TokenRef, to: TokenRef, amountRaw?: bigint): Promise<SwapForUserResult> {
  const { account, walletClient, publicClient } = getAutomationClients()
  const keyAddr = getAutomationAddress()
  const fromToken = from.address as `0x${string}`

  try {
    const [balance, allowance] = await Promise.all([
      publicClient.readContract({ address: fromToken, abi: erc20Abi, functionName: 'balanceOf', args: [userAddress as `0x${string}`] }) as Promise<bigint>,
      publicClient.readContract({ address: fromToken, abi: erc20Abi, functionName: 'allowance', args: [userAddress as `0x${string}`, keyAddr] }) as Promise<bigint>,
    ])
    if (balance === BigInt(0)) return { status: 'nothing_to_sell', message: `No ${from.symbol} balance to sell.` }
    if (allowance === BigInt(0)) return { status: 'not_authorized', message: `Not authorized to move your ${from.symbol} — approve the automation address for ${from.symbol} first.` }

    // Pull the requested amount, capped by both balance and allowance.
    let pullAmount = amountRaw ?? balance
    if (pullAmount > balance) pullAmount = balance
    if (pullAmount > allowance) pullAmount = allowance
    if (pullAmount === BigInt(0)) return { status: 'nothing_to_sell', message: `Nothing to move for ${from.symbol}.` }

    const tfData = encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [userAddress as `0x${string}`, keyAddr, pullAmount] })
    let pullHash: Hash
    try {
      pullHash = await walletClient.sendTransaction({ account, chain: nockChain, to: fromToken, data: tfData, value: BigInt(0) })
    } catch (err) {
      return { status: 'failed', message: `Couldn't pull your ${from.symbol}: ${err instanceof Error ? err.message : 'unknown error'}` }
    }
    const pullRcpt = await publicClient.waitForTransactionReceipt({ hash: pullHash })
    if (pullRcpt.status !== 'success') return { status: 'failed', message: `The ${from.symbol} transfer reverted — nothing was moved.` }

    // Key now holds the token — every failure returns it to the user.
    const keyBalance = (await publicClient.readContract({ address: fromToken, abi: erc20Abi, functionName: 'balanceOf', args: [keyAddr] })) as bigint
    const bail = async (reason: string): Promise<SwapForUserResult> => {
      const returned = await returnTokenToUser(fromToken, userAddress, keyBalance)
      return { status: 'failed', message: `${reason}. ${returned ? `Your ${from.symbol} was returned to your wallet.` : `Your ${from.symbol} is temporarily at the automation address (${keyAddr}); needs manual follow-up, not lost.`}` }
    }

    const quote = await fetchSwapQuote({ fromToken, toToken: to.address, amount: formatUnits(keyBalance, from.decimals), taker: keyAddr })
    if (!quote.transaction || !quote.liquidityAvailable) return bail(`No swap route for ${from.symbol} -> ${to.symbol} right now`)

    try {
      const routerAllowance = (await publicClient.readContract({ address: fromToken, abi: erc20Abi, functionName: 'allowance', args: [keyAddr, quote.transaction.to as `0x${string}`] })) as bigint
      if (routerAllowance < keyBalance) {
        const apData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [quote.transaction.to as `0x${string}`, keyBalance] })
        const apHash = await walletClient.sendTransaction({ account, chain: nockChain, to: fromToken, data: apData, value: BigInt(0) })
        const apRcpt = await publicClient.waitForTransactionReceipt({ hash: apHash })
        if (apRcpt.status !== 'success') return bail(`The ${from.symbol} router approval reverted`)
      }
    } catch (err) {
      return bail(`Approving the swap failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }

    const toAddr = to.address as `0x${string}`
    const boughtBefore = (await publicClient.readContract({ address: toAddr, abi: erc20Abi, functionName: 'balanceOf', args: [keyAddr] })) as bigint
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
    if (swapRcpt.status !== 'success') return bail(`The ${from.symbol} -> ${to.symbol} swap reverted`)

    const boughtAfter = (await publicClient.readContract({ address: toAddr, abi: erc20Abi, functionName: 'balanceOf', args: [keyAddr] })) as bigint
    const bought = boughtAfter - boughtBefore
    if (bought > BigInt(0)) {
      const sendData = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [userAddress as `0x${string}`, bought] })
      const sendHash = await walletClient.sendTransaction({ account, chain: nockChain, to: toAddr, data: sendData, value: BigInt(0) })
      await publicClient.waitForTransactionReceipt({ hash: sendHash })
    }

    return { status: 'executed', soldAmount: formatUnits(keyBalance, from.decimals), boughtAmount: formatUnits(bought, to.decimals), swapTxHash: swapHash }
  } catch (err) {
    console.error('[strategy-execution] swapForUser failed:', err)
    return { status: 'failed', message: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// Sells the user's FULL balance of a token to USDG (stop-loss / take-profit).
export async function executeSellToUsdg(userAddress: string, tokenAddress: string, tokenDecimals: number, tokenSymbol: string): Promise<SwapForUserResult> {
  return swapForUser(userAddress, { address: tokenAddress, decimals: tokenDecimals, symbol: tokenSymbol }, { address: USDG_ADDRESS, decimals: 6, symbol: 'USDG' })
}

// Sell a specific USD-worth of a token to USDG (rebalance: trim an over-weight asset).
export async function sellUsdWorthToUsdg(userAddress: string, token: TokenRef, usdAmount: number, tokenPriceUsd: number): Promise<SwapForUserResult> {
  if (tokenPriceUsd <= 0) return { status: 'failed', message: `No price for ${token.symbol}.` }
  const units = usdAmount / tokenPriceUsd
  const amountRaw = parseUnits(units.toFixed(Math.min(token.decimals, 12)), token.decimals)
  return swapForUser(userAddress, token, { address: USDG_ADDRESS, decimals: 6, symbol: 'USDG' }, amountRaw)
}

// Buy a token with a specific USD-worth of USDG (rebalance: top up an under-weight asset).
export async function buyWithUsdg(userAddress: string, token: TokenRef, usdgAmount: number): Promise<SwapForUserResult> {
  const amountRaw = parseUnits(usdgAmount.toFixed(6), 6)
  return swapForUser(userAddress, { address: USDG_ADDRESS, decimals: 6, symbol: 'USDG' }, token, amountRaw)
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
