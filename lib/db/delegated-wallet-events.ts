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
