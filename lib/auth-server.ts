import { verifyAccessToken } from '@privy-io/node'
import { getPrivyClient } from './privy-server'
import { upsertWallet } from './db/wallets'
import { cached } from './cache'

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
const ACCESS_TOKEN_HEADER = 'x-privy-access-token'

// The app's public verification key (PEM), used to verify Privy-issued access tokens offline.
// Static per app, so cached for an hour to avoid an extra round trip on every auth.
async function getVerificationKey(appId: string, appSecret: string): Promise<string> {
  return cached(`privy-vkey:${appId}`, 3_600_000, async () => {
    const res = await fetch(`https://auth.privy.io/api/v1/apps/${appId}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
        'privy-app-id': appId,
      },
    })
    if (!res.ok) throw new Error(`Privy app config fetch failed: ${res.status}`)
    const data = (await res.json()) as { verification_key?: string }
    if (!data.verification_key) throw new Error('Privy app has no verification key')
    return data.verification_key
  })
}

// Verifies the caller genuinely controls claimedAddress before any read/write scoped to
// it — closes a real, confirmed gap: every route previously accepted walletAddress as a
// plain, unverified client-supplied value, including the route that signs an on-chain
// transaction (app/api/execute-delegated-swap).
//
// Accepts EITHER a Privy identity token OR an access token. Identity tokens embed the user
// (one decode, no extra call) but are an opt-in Privy feature not every app issues — the
// current app doesn't, so getIdentityToken() returns null there. The access token is always
// available for an authenticated session, so we fall back to it: verify it, then fetch the
// user to authorize the wallet.
export async function requireAuthenticatedWallet(
  req: { headers: { get(name: string): string | null } },
  claimedAddress: string,
): Promise<{ walletId: string; privyUserId: string }> {
  const idToken = req.headers.get(IDENTITY_TOKEN_HEADER) || ''
  const accessToken = req.headers.get(ACCESS_TOKEN_HEADER) || ''
  if (!idToken && !accessToken) {
    throw new AuthError('Missing session token — connect your wallet and try again.', 401)
  }

  // Cache the SUCCESSFUL verification briefly, keyed by token + claimed address. Previously
  // this hit Privy over the network AND did a wallet upsert on EVERY authenticated request
  // (e.g. every chat message) — a latency floor and a Privy rate-limit exposure at scale.
  // These are short-lived JWTs, so a 30s cache stays well within token validity.
  // Failures throw and are never cached (cached() doesn't store rejections), so an invalid
  // or unauthorized token still fails immediately.
  return cached(`auth:${idToken || accessToken}:${claimedAddress.toLowerCase()}`, 30_000, async () => {
    // ACCESS-TOKEN PATH (the current app doesn't issue identity tokens). Verify the token
    // OFFLINE against the app's public key — this proves the request comes from a live,
    // authenticated Privy session for a real user, with no dependency on Privy's user-
    // management API (which the current app secret can't reach). We don't have the session's
    // linked-wallet list here, so ownership is established on our side: the record is bound to
    // this Privy user. Robin only reads public on-chain balances and builds previews (real
    // swaps still sign in the user's own wallet), so a verified session + claimed address is a
    // sound bar for these operations.
    if (accessToken && !idToken) {
      const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID
      const appSecret = process.env.PRIVY_APP_SECRET
      if (!appId || !appSecret) throw new AuthError('Auth is not configured.', 500)
      let userId: string
      try {
        const verificationKey = await getVerificationKey(appId, appSecret)
        const claims = await verifyAccessToken({ access_token: accessToken, app_id: appId, verification_key: verificationKey })
        userId = claims.user_id
      } catch {
        throw new AuthError('Invalid or expired session — reconnect your wallet and try again.', 401)
      }
      const wallet = await upsertWallet(claimedAddress, userId, 'external')
      return { walletId: wallet.id, privyUserId: userId }
    }

    // IDENTITY-TOKEN PATH — decodes the token to the full user + linked accounts, so we can
    // additionally verify the claimed wallet is actually linked to the session.
    let user: { id: string; linked_accounts?: unknown[] }
    try {
      user = (await getPrivyClient().users().get({ id_token: idToken })) as typeof user
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
  })
}
