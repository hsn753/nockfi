import { eq, sql } from 'drizzle-orm'
import { getDb } from './client'
import { wallets } from './schema'

// Upsert-on-sight — called once per authenticated request (from requireAuthenticatedWallet
// in lib/auth-server.ts), so last_seen_at naturally stays fresh without a separate job.
export async function upsertWallet(
  address: string,
  privyUserId: string | undefined,
  walletKind: 'external' | 'embedded',
): Promise<{ id: string }> {
  const db = getDb()
  const normalized = address.toLowerCase()

  const [row] = await db
    .insert(wallets)
    .values({ address: normalized, privyUserId, walletKind })
    .onConflictDoUpdate({
      target: wallets.address,
      set: { lastSeenAt: sql`now()`, privyUserId, walletKind },
    })
    .returning({ id: wallets.id })

  return row
}

export async function getWalletByAddress(address: string): Promise<{ id: string } | null> {
  const db = getDb()
  const [row] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(eq(wallets.address, address.toLowerCase()))
    .limit(1)
  return row ?? null
}
