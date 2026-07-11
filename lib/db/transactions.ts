import { eq, sql } from 'drizzle-orm'
import { getDb } from './client'
import { transactions } from './schema'
import { upsertWallet } from './wallets'

export type LogTransactionSubmissionInput = {
  txHash: string | null
  chainId?: number
  walletAddress: string // the wallet whose funds moved
  signerAddress: string
  signerType: 'external' | 'delegated'
  privyWalletId?: string
  agent: string
  actionId?: string
  fromTokenSymbol?: string
  fromTokenAddress?: string
  fromAmount?: string
  toTokenSymbol?: string
  toTokenAddress?: string
  toAmount?: string
  quoteJson?: unknown
  broadcastStatus: 'submitted' | 'no_hash_returned' | 'client_error'
  errorMessage?: string
}

// Phase 1 of the two-phase transaction audit write — called right after a txHash is
// known (or right after we know for certain one was never produced), from the new
// app/api/transactions/log-submission/route.ts. verify_status stays NULL until Phase 2
// (updateTransactionVerification, called from app/api/verify-tx/route.ts) fills it in
// with the independently-verified real outcome.
export async function logTransactionSubmission(input: LogTransactionSubmissionInput): Promise<{ id: string }> {
  const db = getDb()
  const wallet = await upsertWallet(input.walletAddress, undefined, 'external')

  const [row] = await db
    .insert(transactions)
    .values({
      txHash: input.txHash,
      chainId: input.chainId ?? 4663,
      walletId: wallet.id,
      signerAddress: input.signerAddress.toLowerCase(),
      signerType: input.signerType,
      privyWalletId: input.privyWalletId,
      agent: input.agent,
      actionId: input.actionId,
      fromTokenSymbol: input.fromTokenSymbol,
      fromTokenAddress: input.fromTokenAddress,
      fromAmount: input.fromAmount,
      toTokenSymbol: input.toTokenSymbol,
      toTokenAddress: input.toTokenAddress,
      toAmount: input.toAmount,
      quoteJson: input.quoteJson,
      broadcastStatus: input.broadcastStatus,
      errorMessage: input.errorMessage,
    })
    .returning({ id: transactions.id })

  return row
}

// Phase 2 — the ONLY writer of verify_status, called from app/api/verify-tx/route.ts
// right after its own independent getTransactionReceipt() check resolves. This keeps
// the database in permanent agreement with what the user was actually told, since
// verify-tx is already the sole authority on success/revert/not-found for the app itself.
export async function updateTransactionVerification(
  txHash: string,
  verifyStatus: 'success' | 'reverted' | 'not_found',
  verifyBlockNumber?: string,
): Promise<void> {
  const db = getDb()
  await db
    .update(transactions)
    .set({
      verifyStatus,
      verifyBlockNumber,
      verifiedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(transactions.txHash, txHash))
}
