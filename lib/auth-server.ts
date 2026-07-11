import { getPrivyClient } from './privy-server'
import { upsertWallet } from './db/wallets'

// Confirmed directly against the installed @privy-io/node package (not guessed):
// PrivyClient.users(): PrivyUsersService, and PrivyUsersService.get({ id_token })
// verifies the token and returns the full User object, including linked_accounts with
// real wallet addresses. No extra Privy dashboard key is needed — jwtVerificationKey on
// PrivyClientOptions is optional, and when omitted (as it is in getPrivyClient()),
// Privy auto-fetches its own public JWKS using the app ID already configured.

export class AuthError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const IDENTITY_TOKEN_HEADER = 'x-privy-identity-token'

// Verifies the caller genuinely controls claimedAddress before any read/write scoped to
// it — closes a real, confirmed gap: every route previously accepted walletAddress as a
// plain, unverified client-supplied value, including the route that signs an on-chain
// transaction (app/api/execute-delegated-swap).
export async function requireAuthenticatedWallet(
  req: { headers: { get(name: string): string | null } },
  claimedAddress: string,
): Promise<{ walletId: string; privyUserId: string }> {
  const token = req.headers.get(IDENTITY_TOKEN_HEADER)
  if (!token) {
    throw new AuthError('Missing identity token — connect your wallet and try again.', 401)
  }

  let user
  try {
    user = await getPrivyClient().users().get({ id_token: token })
  } catch {
    throw new AuthError('Invalid or expired session — reconnect your wallet and try again.', 401)
  }

  const normalizedClaim = claimedAddress.toLowerCase()
  const linkedAccounts = (user.linked_accounts ?? []) as any[]
  const ownsAddress = linkedAccounts.some(
    (a) => a.type === 'wallet' && typeof a.address === 'string' && a.address.toLowerCase() === normalizedClaim,
  )

  if (!ownsAddress) {
    throw new AuthError("This wallet address isn't linked to your authenticated session.", 403)
  }

  const embeddedEntry = linkedAccounts.find(
    (a) => a.type === 'wallet' && typeof a.address === 'string' && a.address.toLowerCase() === normalizedClaim && a.wallet_client_type === 'privy',
  )

  const wallet = await upsertWallet(claimedAddress, user.id, embeddedEntry ? 'embedded' : 'external')
  return { walletId: wallet.id, privyUserId: user.id }
}
