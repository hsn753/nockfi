// Bridging happens entirely outside this app (the user signs on portal.arbitrum.io,
// an Ethereum L1 transaction), so there's no transaction of ours to await. Instead,
// once Robin gives out the bridge link, we snapshot the wallet's current Robinhood
// Chain USD total and poll for it to increase — that's the only signal available
// without wiring up L1 event tracking for Arbitrum retryable tickets.
const STORAGE_PREFIX = 'nock:pendingBridge:'
const AUTO_EXPIRE_MS = 45 * 60 * 1000 // 45 minutes

export type PendingBridge = {
  startedAt: number
  snapshotUsd: number
}

export function startBridgeWatch(walletAddress: string, snapshotUsd: number) {
  try {
    localStorage.setItem(
      STORAGE_PREFIX + walletAddress.toLowerCase(),
      JSON.stringify({ startedAt: Date.now(), snapshotUsd } satisfies PendingBridge),
    )
  } catch {
    // Storage unavailable — bridging still works, just without status tracking.
  }
}

export function getPendingBridge(walletAddress: string): PendingBridge | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + walletAddress.toLowerCase())
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingBridge
    if (Date.now() - parsed.startedAt > AUTO_EXPIRE_MS) {
      clearBridgeWatch(walletAddress)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function clearBridgeWatch(walletAddress: string) {
  try {
    localStorage.removeItem(STORAGE_PREFIX + walletAddress.toLowerCase())
  } catch {
    // Ignore.
  }
}
