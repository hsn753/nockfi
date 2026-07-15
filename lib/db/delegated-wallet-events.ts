import { eq } from 'drizzle-orm'
import { getDb } from './client'
import { delegatedWalletEvents } from './schema'
import { upsertWallet } from './wallets'

export type LogDelegatedWalletEventInput = {
  ownerWalletAddress: string // the connected/external identity that owns this instant-swap wallet
  embeddedAddress: string
  privyWalletId: string
  signerId: string
  policyId: string
  eventType: 'created' | 'enabled' | 'disabled' | 'export_initiated'
}

// Append-only log of instant-swap wallet lifecycle events (Settings -> Instant swaps),
// durable even if Privy's own dashboard-side policy/signer registration later changes.
export async function logDelegatedWalletEvent(input: LogDelegatedWalletEventInput): Promise<void> {
  const db = getDb()
  const wallet = await upsertWallet(input.ownerWalletAddress, undefined, 'external')

  await db.insert(delegatedWalletEvents).values({
    walletId: wallet.id,
    embeddedAddress: input.embeddedAddress.toLowerCase(),
    privyWalletId: input.privyWalletId,
    signerId: input.signerId,
    policyId: input.policyId,
    eventType: input.eventType,
  })
}

// The Privy walletIds ever registered for a given embedded address, from the auth-guarded
// delegation log above. execute-delegated-swap uses this to bind the walletId it signs with
// to the *authenticated* wallet: the caller can only sign a walletId they themselves
// registered, never an arbitrary one supplied in the request body (which would otherwise
// let an authenticated user drive signing on someone else's delegated wallet).
export async function getRegisteredWalletIds(embeddedAddress: string): Promise<string[]> {
  const db = getDb()
  const rows = await db
    .select({ privyWalletId: delegatedWalletEvents.privyWalletId })
    .from(delegatedWalletEvents)
    .where(eq(delegatedWalletEvents.embeddedAddress, embeddedAddress.toLowerCase()))
  return [...new Set(rows.map((r) => r.privyWalletId))]
}
