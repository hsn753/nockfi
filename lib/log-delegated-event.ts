export type DelegatedWalletEventType = 'created' | 'enabled' | 'disabled' | 'export_initiated'

export type LogDelegatedWalletEventParams = {
  ownerWalletAddress: string
  embeddedAddress: string
  privyWalletId: string
  signerId: string
  policyId: string
  eventType: DelegatedWalletEventType
  identityToken: string | null
}

// Fire-and-forget client-side call to app/api/delegated-wallet-events — logging must
// never block or break the actual Settings action (create/enable/disable/export) the
// user is waiting on. identityToken proves ownerWalletAddress to the server (see
// lib/auth-server.ts) — without it the server has no way to know this isn't logging an
// event under someone else's wallet address.
export function logDelegatedWalletEventClient({ identityToken, ...params }: LogDelegatedWalletEventParams): void {
  fetch('/api/delegated-wallet-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Privy-Identity-Token': identityToken ?? '' },
    body: JSON.stringify(params),
  }).catch((err) => console.error('[Nock] Could not log delegated wallet event:', err))
}
