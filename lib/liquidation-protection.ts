import { erc20Abi, encodeFunctionData, parseUnits, type Hash } from 'viem'
import { nockChain } from './chain'
import {
  getUserMarketPositions,
  getMorphoMarketData,
  buildMarketWithdraw,
  isAutomationAuthorized,
  USDG_ADDRESS,
  USDG_DECIMALS,
} from './get-morpho-markets'
import { getStockBorrowPositions, buildLiquidationRepayTx } from './get-stock-collateral'
import { getAutomationClients, getAutomationAddress } from './yield-automation'
import { withAutomationLock } from './automation-lock'
import {
  getEnabledLiquidationProtectionWallets,
  disableLiquidationProtection,
  touchLiquidationProtectionCheckedAt,
  recordLiquidationProtectionEvent,
} from './db/liquidation-protection'

// Automated liquidation protection — when a stock-collateral loan's LTV-utilization crosses
// the user's trigger, pull USDG from their own Morpho YIELD position and repay the loan down
// to a safe target LTV, all signed by the shared automation key on the user's behalf.
//
// Funding source is the user's yield position ONLY (the chosen design): it needs NO custody
// beyond the Morpho setAuthorization grant the user already made (that grant is global per
// address, so it covers BOTH the yield withdraw AND the collateral repay). If the user has
// no/insufficient yield to pull from, we DON'T touch their wallet — we record an
// insufficient_funds event; the existing loan-risk monitor already surfaces the urgent
// alert. Everything here is pro-user (de-risking their own position); nothing leaves to a
// third party — repaid debt is theirs, pulled yield is theirs.

export function liquidationProtectionEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LIQUIDATION_PROTECTION_ENABLED === 'true' && !!process.env.YIELD_AUTOMATION_PRIVATE_KEY
}

export type ProtectionSweepSummary = {
  checked: number
  protected: number
  atRiskButNoYield: number
  autoDisabledRevoked: number
  failed: number
  noRisk: number
}

const EMPTY_PROTECTION_SUMMARY: ProtectionSweepSummary = { checked: 0, protected: 0, atRiskButNoYield: 0, autoDisabledRevoked: 0, failed: 0, noRisk: 0 }

// Serialized against every other sweep (any type, any pm2 worker) via withAutomationLock —
// see its comment for why an in-process-only lock isn't enough on production's 2 workers.
export async function runLiquidationProtectionSweep(): Promise<ProtectionSweepSummary> {
  const result = await withAutomationLock('liquidation-protection', runLiquidationProtectionSweepInner)
  return result ?? EMPTY_PROTECTION_SUMMARY
}

async function runLiquidationProtectionSweepInner(): Promise<ProtectionSweepSummary> {
  const summary: ProtectionSweepSummary = { ...EMPTY_PROTECTION_SUMMARY }
  const automationAddress = getAutomationAddress()
  const wallets = await getEnabledLiquidationProtectionWallets()

  for (const w of wallets) {
    summary.checked++
    try {
      // Same on-chain grant as yield automation — re-verify (user may have revoked directly).
      const stillAuthorized = await isAutomationAuthorized(w.address, automationAddress)
      if (!stillAuthorized) {
        await disableLiquidationProtection(w.walletId)
        summary.autoDisabledRevoked++
        continue
      }

      const trigger = Number(w.triggerLtvPct)
      const target = Number(w.targetLtvPct)
      const loans = await getStockBorrowPositions(w.address)
      const atRisk = loans.filter((l) => l.borrowedUsd > 0 && l.ltvUtilizationPct >= trigger)
      if (atRisk.length === 0) {
        summary.noRisk++
        await touchLiquidationProtectionCheckedAt(w.walletId)
        continue
      }

      let didProtect = false
      let hadFailure = false
      let hadNoYield = false

      for (const loan of atRisk) {
        // Debt to clear to reach the target LTV-utilization. util = borrowed / maxDebt,
        // so maxDebt = borrowed / (util/100); targetDebt = maxDebt * (target/100).
        const maxDebtUsd = loan.borrowedUsd / (loan.ltvUtilizationPct / 100)
        const targetDebtUsd = maxDebtUsd * (target / 100)
        const repayNeededUsd = Math.max(0, loan.borrowedUsd - targetDebtUsd)
        if (repayNeededUsd < 0.01) continue

        const outcome = await protectLoan(w.address, loan.stockSymbol, loan.ltvUtilizationPct, target, repayNeededUsd)
        await recordLiquidationProtectionEvent({
          walletId: w.walletId,
          stockSymbol: loan.stockSymbol,
          ltvBeforePct: loan.ltvUtilizationPct,
          ltvTargetPct: target,
          repaidUsdg: outcome.repaidUsdg,
          fundedFromMarket: outcome.fundedFromMarket,
          withdrawTxHash: outcome.withdrawTxHash,
          repayTxHash: outcome.repayTxHash,
          status: outcome.status,
          errorMessage: outcome.error,
        })
        if (outcome.status === 'protected') didProtect = true
        else if (outcome.status === 'insufficient_funds') hadNoYield = true
        else hadFailure = true
      }

      if (didProtect) summary.protected++
      if (hadFailure) summary.failed++
      if (hadNoYield) summary.atRiskButNoYield++
      await touchLiquidationProtectionCheckedAt(w.walletId)
    } catch (err) {
      console.error(`[liquidation-protection] Sweep failed for ${w.address}:`, err)
      summary.failed++
    }
  }

  return summary
}

type ProtectOutcome = {
  status: 'protected' | 'insufficient_funds' | 'failed'
  repaidUsdg?: string
  fundedFromMarket?: string
  withdrawTxHash?: Hash
  repayTxHash?: Hash
  error?: string
}

async function protectLoan(
  userAddress: string,
  stockSymbol: string,
  ltvBeforePct: number,
  targetPct: number,
  repayNeededUsd: number,
): Promise<ProtectOutcome> {
  const { account, walletClient, publicClient } = getAutomationClients()

  // 1. Fund the repay by pulling from the user's yield position(s), largest first, capped
  // by each market's real idle liquidity. Withdraw to the automation key (receiver = us)
  // so it holds the USDG to repay with (Morpho repay pulls from msg.sender).
  const [positions, marketData] = await Promise.all([getUserMarketPositions(userAddress), getMorphoMarketData()])
  const sorted = [...positions].sort((a, b) => b.suppliedUsd - a.suppliedUsd)
  let pulledUsd = 0
  let firstWithdrawTx: Hash | undefined
  let fundedFromMarket: string | undefined

  for (const pos of sorted) {
    if (pulledUsd >= repayNeededUsd - 0.01) break
    const md = marketData.find((m) => m.key === pos.market)
    const capacity = Math.min(pos.suppliedUsd, md ? md.availableLiquidityUsd : pos.suppliedUsd)
    const pull = Math.min(repayNeededUsd - pulledUsd, capacity)
    if (pull < 0.01) continue
    const amount = pull.toFixed(6)
    const wq = await buildMarketWithdraw(userAddress, amount, pos.market, account.address)
    if ('error' in wq) continue
    try {
      const hash = await walletClient.sendTransaction({
        account, chain: nockChain,
        to: wq.transaction.to as `0x${string}`, data: wq.transaction.data as `0x${string}`,
        value: BigInt(wq.transaction.value || '0'), gas: BigInt(wq.transaction.gas),
      })
      const rcpt = await publicClient.waitForTransactionReceipt({ hash })
      if (rcpt.status !== 'success') continue
      pulledUsd += pull
      if (!firstWithdrawTx) { firstWithdrawTx = hash; fundedFromMarket = pos.market }
    } catch (err) {
      console.error('[liquidation-protection] yield withdraw failed:', err)
    }
  }

  if (pulledUsd < 0.01) {
    // No yield could be pulled — do NOT touch the wallet (by design). The loan-risk
    // monitor already alerts the user; we just record that auto-protection couldn't act.
    return { status: 'insufficient_funds', error: 'No yield position available to fund an auto-repay. Loan left as-is; user alerted.' }
  }

  // 2. Approve Morpho to pull the pulled USDG from the automation key, then repay on behalf.
  const repayUsd = pulledUsd.toFixed(6)
  const bail = async (reason: string): Promise<ProtectOutcome> => {
    // Repay didn't happen but we're holding the user's withdrawn yield — send it back.
    const returned = await returnUsdgToUser(userAddress, parseUnits(repayUsd, USDG_DECIMALS))
    const fate = returned ? 'Withdrawn yield was returned to your wallet.' : `Withdrawn yield is temporarily at the automation address (${account.address}); needs manual follow-up, not lost.`
    return { status: 'failed', error: `Pulled ${repayUsd} USDG from yield but ${reason}. ${fate}`, withdrawTxHash: firstWithdrawTx, fundedFromMarket, repaidUsdg: '0' }
  }

  const repayTx = await buildLiquidationRepayTx(stockSymbol, repayUsd, userAddress)
  if ('error' in repayTx) return bail(`couldn't build the repay: ${repayTx.error}`)

  try {
    const amtWei = parseUnits(repayUsd, USDG_DECIMALS)
    const allowance = (await publicClient.readContract({
      address: USDG_ADDRESS, abi: erc20Abi, functionName: 'allowance', args: [account.address, repayTx.to],
    })) as bigint
    if (allowance < amtWei) {
      const approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [repayTx.to, amtWei] })
      const ah = await walletClient.sendTransaction({ account, chain: nockChain, to: USDG_ADDRESS, data: approveData, value: BigInt(0) })
      const ar = await publicClient.waitForTransactionReceipt({ hash: ah })
      if (ar.status !== 'success') return bail('the USDG approval for the repay reverted')
    }
  } catch (err) {
    return bail(`approving the repay failed: ${err instanceof Error ? err.message : 'unknown error'}`)
  }

  let repayTxHash: Hash
  try {
    repayTxHash = await walletClient.sendTransaction({ account, chain: nockChain, to: repayTx.to, data: repayTx.data, value: BigInt(0) })
  } catch (err) {
    return bail(`the repay failed to submit: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  const repayReceipt = await publicClient.waitForTransactionReceipt({ hash: repayTxHash })
  if (repayReceipt.status !== 'success') return bail('the repay reverted on-chain')

  return { status: 'protected', repaidUsdg: repayUsd, fundedFromMarket, withdrawTxHash: firstWithdrawTx, repayTxHash }
}

// Safety net: return the automation key's USDG to the user if a repay couldn't complete
// after we already withdrew their yield. Best-effort; never throws.
async function returnUsdgToUser(userAddress: string, amountWei: bigint): Promise<boolean> {
  try {
    const { account, walletClient, publicClient } = getAutomationClients()
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [userAddress as `0x${string}`, amountWei] })
    const hash = await walletClient.sendTransaction({ account, chain: nockChain, to: USDG_ADDRESS, data, value: BigInt(0) })
    const rcpt = await publicClient.waitForTransactionReceipt({ hash })
    return rcpt.status === 'success'
  } catch (err) {
    console.error('[liquidation-protection] returnUsdgToUser failed:', err)
    return false
  }
}
