import { createWalletClient, createPublicClient, http, erc20Abi, encodeFunctionData, parseUnits, type Hash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { nockChain } from './chain'
import {
  type MorphoMarketKey,
  getMorphoMarketData,
  getUserMarketPositions,
  buildMarketSupply,
  buildMarketWithdraw,
  isAutomationAuthorized,
  USDG_ADDRESS,
  USDG_DECIMALS,
} from './get-morpho-markets'
import {
  getEnabledYieldAutomationWallets,
  disableYieldAutomation,
  touchYieldAutomationCheckedAt,
  recordYieldAutomationEvent,
} from './db/yield-automation'

// Automated yield rebalancing — moves a user's EXISTING Morpho position to whichever
// approved market currently pays a materially better rate. Does NOT sweep idle wallet
// balance into yield automatically (that's a bigger behavior change than "switch to the
// best rate" — v1 only manages funds the user already chose to lend).
//
// No session-signer / Instant-Swaps wallet involved. The user grants authorization ONCE
// via Morpho Blue's own on-chain setAuthorization(automationAddress, true) — a normal
// wallet signature (see components/nock/settings-view.tsx) — after which this dedicated
// key can call supply/withdraw with onBehalf = them. Every write here is preceded by an
// independent on-chain isAuthorized check; a user revoking directly on-chain (bypassing
// our own /disable endpoint) is caught and reflected in our DB, not silently ignored.

// Same env-gate as houdiniEnabled() in lib/houdini.ts — see the comment on
// YIELD_AUTOMATION_ENABLED in lib/feature-flags.ts for why this can't be a hardcoded
// boolean. Checked independently server-side (not just the client's NEXT_PUBLIC read) so
// every API route here fails closed even if something reaches an unconfigured environment.
export function yieldAutomationEnabled(): boolean {
  return process.env.NEXT_PUBLIC_YIELD_AUTOMATION_ENABLED === 'true' && !!process.env.YIELD_AUTOMATION_PRIVATE_KEY
}

let automationAccount: ReturnType<typeof privateKeyToAccount> | null = null

function getAutomationAccount() {
  if (!automationAccount) {
    const pk = process.env.YIELD_AUTOMATION_PRIVATE_KEY
    if (!pk) throw new Error('YIELD_AUTOMATION_PRIVATE_KEY not configured')
    automationAccount = privateKeyToAccount(pk as `0x${string}`)
    const expected = process.env.NEXT_PUBLIC_YIELD_AUTOMATION_ADDRESS
    if (expected && automationAccount.address.toLowerCase() !== expected.toLowerCase()) {
      // Fail loud rather than silently signing with an address that doesn't match what
      // the client shows users when they grant authorization — a mismatch here means
      // this key can never actually act for anyone (nothing is authorized to IT).
      throw new Error('YIELD_AUTOMATION_PRIVATE_KEY does not match NEXT_PUBLIC_YIELD_AUTOMATION_ADDRESS')
    }
  }
  return automationAccount
}

export function getAutomationAddress(): `0x${string}` {
  return getAutomationAccount().address
}

function getClients() {
  const account = getAutomationAccount()
  const transport = http(process.env.RPC_URL)
  const walletClient = createWalletClient({ account, chain: nockChain, transport })
  const publicClient = createPublicClient({ chain: nockChain, transport })
  return { account, walletClient, publicClient }
}

export type SweepSummary = {
  checked: number
  rebalanced: number
  skippedNoPosition: number
  skippedNoImprovement: number
  autoDisabledRevoked: number
  failed: number
}

// One pass over every wallet with automation enabled. Safe to call repeatedly (e.g. from
// a cron sweep) — a wallet with nothing to improve is a cheap no-op.
export async function runYieldAutomationSweep(): Promise<SweepSummary> {
  const summary: SweepSummary = { checked: 0, rebalanced: 0, skippedNoPosition: 0, skippedNoImprovement: 0, autoDisabledRevoked: 0, failed: 0 }
  const automationAddress = getAutomationAddress()
  const wallets = await getEnabledYieldAutomationWallets()
  const marketData = await getMorphoMarketData()

  for (const w of wallets) {
    summary.checked++
    try {
      // Defensive: the user can always revoke setAuthorization directly on-chain,
      // bypassing our /disable endpoint. Never act on stale DB state.
      const stillAuthorized = await isAutomationAuthorized(w.address, automationAddress)
      if (!stillAuthorized) {
        await disableYieldAutomation(w.walletId)
        summary.autoDisabledRevoked++
        continue
      }

      const positions = await getUserMarketPositions(w.address)
      if (!positions.length) {
        summary.skippedNoPosition++
        await touchYieldAutomationCheckedAt(w.walletId)
        continue
      }

      const minDelta = Number(w.minApyDeltaPct)
      let didRebalance = false

      for (const position of positions) {
        const currentMarket = marketData.find((m) => m.key === position.market)
        if (!currentMarket) continue

        // Best OTHER market with a materially higher rate and room for both legs.
        const candidate = [...marketData]
          .filter((m) => m.key !== position.market)
          .filter((m) => m.supplyApyPct >= currentMarket.supplyApyPct + minDelta)
          .filter((m) => m.availableLiquidityUsd >= position.suppliedUsd) // destination can accept the deposit
          .filter(() => currentMarket.availableLiquidityUsd >= position.suppliedUsd) // source can release it
          .sort((a, b) => b.supplyApyPct - a.supplyApyPct)[0]

        if (!candidate) continue

        const amount = position.suppliedUsd.toFixed(6)
        const result = await rebalancePosition(w.address, position.market, candidate.key as MorphoMarketKey, amount)
        await recordYieldAutomationEvent({
          walletId: w.walletId,
          fromMarket: position.market,
          toMarket: candidate.key,
          amountUsdg: amount,
          fromApyPct: currentMarket.supplyApyPct,
          toApyPct: candidate.supplyApyPct,
          withdrawTxHash: result.withdrawTxHash,
          supplyTxHash: result.supplyTxHash,
          status: result.ok ? 'success' : 'failed',
          errorMessage: result.ok ? undefined : result.error,
        })
        if (result.ok) {
          didRebalance = true
        } else {
          summary.failed++
        }
      }

      if (didRebalance) summary.rebalanced++
      else if (!summary.failed) summary.skippedNoImprovement++
      await touchYieldAutomationCheckedAt(w.walletId)
    } catch (err) {
      console.error(`[yield-automation] Sweep failed for ${w.address}:`, err)
      summary.failed++
    }
  }

  return summary
}

type RebalanceResult = { ok: true; withdrawTxHash: Hash; supplyTxHash: Hash } | { ok: false; error: string; withdrawTxHash?: Hash; supplyTxHash?: Hash }

// Morpho Blue's supply() pulls the loan token from msg.sender, NOT from `onBehalf` — so
// the automation key must actually receive the withdrawn USDG itself (receiver = the
// automation address, not the user) to be able to approve + re-supply it a moment later.
// This means funds pass THROUGH the automation key's own wallet for the few seconds
// between the two legs. Every failure path from here on attempts to send the withdrawn
// amount straight back to the user (returnFundsToUser) rather than leaving it stranded —
// this is the safety net that makes the transient custody window acceptable.
async function rebalancePosition(
  userAddress: string,
  fromMarket: MorphoMarketKey,
  toMarket: MorphoMarketKey,
  amount: string,
): Promise<RebalanceResult> {
  const { account, walletClient, publicClient } = getClients()

  const withdrawQuote = await buildMarketWithdraw(userAddress, amount, fromMarket, account.address)
  if ('error' in withdrawQuote) return { ok: false, error: withdrawQuote.error }

  let withdrawTxHash: Hash
  try {
    withdrawTxHash = await walletClient.sendTransaction({
      account,
      chain: nockChain,
      to: withdrawQuote.transaction.to as `0x${string}`,
      data: withdrawQuote.transaction.data as `0x${string}`,
      value: BigInt(withdrawQuote.transaction.value || '0'),
      gas: BigInt(withdrawQuote.transaction.gas),
    })
  } catch (err) {
    // Nothing was pulled anywhere yet — funds are exactly where they started, in fromMarket.
    return { ok: false, error: err instanceof Error ? err.message : 'Withdraw failed to submit' }
  }
  const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash: withdrawTxHash })
  if (withdrawReceipt.status !== 'success') {
    return { ok: false, error: `Withdraw from ${fromMarket} reverted on-chain — funds stayed in ${fromMarket}.`, withdrawTxHash }
  }

  // Past this point the automation key HOLDS the withdrawn USDG — every remaining failure
  // path must try to return it to the user before giving up.
  const amountWei = parseUnits(amount, USDG_DECIMALS)
  const bail = async (reason: string) => {
    const returned = await returnFundsToUser(walletClient, publicClient, account, userAddress, amountWei)
    const fate = returned
      ? `Funds were sent back to your wallet automatically.`
      : `Could not automatically return funds — they are temporarily held at the automation address (${account.address}); this needs manual follow-up, they are not lost.`
    return { ok: false as const, error: `Withdrew from ${fromMarket} but ${reason}. ${fate}`, withdrawTxHash }
  }

  const supplyQuote = await buildMarketSupply(userAddress, amount, toMarket)
  if ('error' in supplyQuote) {
    return bail(`couldn't re-supply to ${toMarket}: ${supplyQuote.error}`)
  }

  // supply() pulls from msg.sender (the automation key) — approve Morpho for the exact
  // amount if the current allowance is short (matches lib/execute-swap.ts's convention of
  // approving the exact amount, not an unlimited allowance).
  try {
    const currentAllowance = await publicClient.readContract({
      address: USDG_ADDRESS, abi: erc20Abi, functionName: 'allowance', args: [account.address, supplyQuote.transaction.to as `0x${string}`],
    })
    if (currentAllowance < amountWei) {
      const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [supplyQuote.transaction.to as `0x${string}`, amountWei] })
      const approveHash = await walletClient.sendTransaction({ account, chain: nockChain, to: USDG_ADDRESS, data: approveData, value: BigInt(0) })
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
      if (approveReceipt.status !== 'success') return bail(`the approval to re-supply to ${toMarket} reverted on-chain`)
    }
  } catch (err) {
    return bail(`approving the re-supply to ${toMarket} failed: ${err instanceof Error ? err.message : 'unknown error'}`)
  }

  let supplyTxHash: Hash
  try {
    supplyTxHash = await walletClient.sendTransaction({
      account,
      chain: nockChain,
      to: supplyQuote.transaction.to as `0x${string}`,
      data: supplyQuote.transaction.data as `0x${string}`,
      value: BigInt(supplyQuote.transaction.value || '0'),
      gas: BigInt(supplyQuote.transaction.gas),
    })
  } catch (err) {
    return bail(`the re-supply to ${toMarket} failed to submit: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  const supplyReceipt = await publicClient.waitForTransactionReceipt({ hash: supplyTxHash })
  if (supplyReceipt.status !== 'success') {
    const result = await bail(`the re-supply to ${toMarket} reverted on-chain`)
    return { ...result, supplyTxHash }
  }

  return { ok: true, withdrawTxHash, supplyTxHash }
}

// Last-resort safety net: send the automation key's own USDG balance back to the user via
// a plain ERC20 transfer. Best-effort — returns false (never throws) so callers can still
// report a clear "needs manual follow-up" message rather than crashing the sweep.
async function returnFundsToUser(
  walletClient: ReturnType<typeof getClients>['walletClient'],
  publicClient: ReturnType<typeof getClients>['publicClient'],
  account: ReturnType<typeof getClients>['account'],
  userAddress: string,
  amountWei: bigint,
): Promise<boolean> {
  try {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [userAddress as `0x${string}`, amountWei] })
    const hash = await walletClient.sendTransaction({ account, chain: nockChain, to: USDG_ADDRESS, data, value: BigInt(0) })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    return receipt.status === 'success'
  } catch (err) {
    console.error('[yield-automation] returnFundsToUser failed:', err)
    return false
  }
}
