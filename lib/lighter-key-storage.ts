// Encrypted local persistence for a user's own Lighter API private key. No separate
// passphrase to set or lose — the connected wallet itself is the secret. The wrapping
// AES key is derived from a signature over a fixed message; wallet signatures are
// deterministic (RFC6979 ECDSA), so the same wallet re-derives the same AES key every
// time from a fresh signMessage call, with nothing but the encrypted blob ever persisted.
//
// Nock's servers never see any of this — everything here runs in the browser and is
// stored in localStorage, scoped per wallet address.

const STORAGE_PREFIX = 'nock:lighter-key:'

type StoredKey = {
  v: 1
  accountIndex: number
  apiKeyIndex: number
  publicKey: string // hex, not secret — safe to display
  iv: string // base64
  ciphertext: string // base64, AES-256-GCM(privateKeyHex)
}

function storageKey(walletAddress: string): string {
  return `${STORAGE_PREFIX}${walletAddress.toLowerCase()}`
}

export function buildWrapMessage(walletAddress: string): string {
  return (
    `Nock Perps Key\n\n` +
    `address: ${walletAddress}\n` +
    `Only sign this to unlock your Nock trading key. Do not sign this on any other site.`
  )
}

export function loadStoredKeyMeta(
  walletAddress: string,
): { accountIndex: number; apiKeyIndex: number; publicKey: string } | null {
  try {
    const raw = localStorage.getItem(storageKey(walletAddress))
    if (!raw) return null
    const stored = JSON.parse(raw) as StoredKey
    return { accountIndex: stored.accountIndex, apiKeyIndex: stored.apiKeyIndex, publicKey: stored.publicKey }
  } catch {
    return null
  }
}

export function clearStoredKey(walletAddress: string): void {
  localStorage.removeItem(storageKey(walletAddress))
}

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

async function deriveAesKey(wrapSignature: string): Promise<CryptoKey> {
  const sigBytes = new TextEncoder().encode(wrapSignature)
  const digest = await crypto.subtle.digest('SHA-256', sigBytes)
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function wrapAndStore(args: {
  walletAddress: string
  accountIndex: number
  apiKeyIndex: number
  publicKey: string
  privateKeyHex: string
  wrapSignature: string
}): Promise<void> {
  const key = await deriveAesKey(args.wrapSignature)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(args.privateKeyHex),
  )
  const stored: StoredKey = {
    v: 1,
    accountIndex: args.accountIndex,
    apiKeyIndex: args.apiKeyIndex,
    publicKey: args.publicKey,
    iv: toBase64(iv.buffer),
    ciphertext: toBase64(ciphertext),
  }
  localStorage.setItem(storageKey(args.walletAddress), JSON.stringify(stored))
}

export async function unlockPrivateKey(args: { walletAddress: string; wrapSignature: string }): Promise<string> {
  const raw = localStorage.getItem(storageKey(args.walletAddress))
  if (!raw) throw new Error('No stored Lighter key for this wallet.')
  const stored = JSON.parse(raw) as StoredKey
  const key = await deriveAesKey(args.wrapSignature)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(stored.iv) },
    key,
    fromBase64(stored.ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}
