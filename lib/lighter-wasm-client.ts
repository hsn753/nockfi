// Browser-only wrapper around the Lighter Go signer, compiled to WASM
// (public/lighter/lighter-signer.wasm + wasm_exec.js). This is what makes per-user,
// non-custodial Lighter trading possible: the private key is generated and used
// entirely client-side, in a plain browser, with no server in the signing loop.
//
// Proven working end-to-end against the live RH Lighter instance (see memory
// nockfi-de-prod-perps-live.md) — the exact same WASM build, exact same call
// shapes. This file only adds a browser-appropriate loader on top (Node used
// `require('./wasm_exec.js')`; a browser needs a <script> tag instead).

declare global {
  interface Window {
    Go?: new () => {
      importObject: WebAssembly.Imports
      run: (instance: WebAssembly.Instance) => void
    }
    GenerateAPIKey?: () => { privateKey: string; publicKey: string; error?: string }
    CreateClient?: (
      url: string,
      privateKey: string,
      chainId: number,
      apiKeyIndex: number,
      accountIndex: number,
    ) => { error?: string }
    SignChangePubKey?: (
      pubKeyHex: string,
      skipNonce: number,
      nonce: number,
      apiKeyIndex: number,
      accountIndex: number,
    ) => { txType: number; txInfo: string; txHash: string; messageToSign: string; error?: string }
    SignCreateOrder?: (...args: number[]) => { txType: number; txInfo: string; txHash: string; error?: string }
    SignUpdateLeverage?: (...args: number[]) => { txType: number; txInfo: string; txHash: string; error?: string }
  }
}

const WASM_JS_URL = '/lighter/wasm_exec.js'
const WASM_BINARY_URL = '/lighter/lighter-signer.wasm'

let loadPromise: Promise<void> | null = null

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(script)
  })
}

async function instantiateWasm(go: InstanceType<NonNullable<Window['Go']>>) {
  // Prefer instantiateStreaming (avoids buffering the full ~14MB in memory twice), but
  // some static hosts don't send `application/wasm` — that makes instantiateStreaming
  // reject even though the bytes are fine, so fall back to a plain fetch + instantiate.
  try {
    const resp = await fetch(WASM_BINARY_URL)
    return await WebAssembly.instantiateStreaming(resp, go.importObject)
  } catch {
    const resp = await fetch(WASM_BINARY_URL)
    const bytes = await resp.arrayBuffer()
    return await WebAssembly.instantiate(bytes, go.importObject)
  }
}

// Idempotent — safe to call from multiple components; only loads once per page.
export async function loadLighterSigner(): Promise<void> {
  if (typeof window !== 'undefined' && typeof window.GenerateAPIKey === 'function') return
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    if (!window.Go) {
      await loadScript(WASM_JS_URL)
    }
    if (!window.Go) throw new Error('Lighter signer script loaded but window.Go is missing.')

    const go = new window.Go()
    const { instance } = await instantiateWasm(go)
    go.run(instance) // registers window.GenerateAPIKey etc., then blocks internally

    // The Go runtime registers its JS globals synchronously during go.run's first
    // tick, but go.run itself doesn't resolve (the program blocks forever) — poll
    // briefly rather than guessing a fixed delay.
    const deadline = Date.now() + 5000
    while (typeof window.GenerateAPIKey !== 'function') {
      if (Date.now() > deadline) throw new Error('Lighter signer did not initialize in time.')
      await new Promise((r) => setTimeout(r, 50))
    }
  })()

  return loadPromise
}

function checkErr<T extends { error?: string }>(result: T, label: string): T {
  if (result?.error) throw new Error(`${label}: ${result.error}`)
  return result
}

export function generateApiKey(): { privateKey: string; publicKey: string } {
  if (!window.GenerateAPIKey) throw new Error('Lighter signer not loaded — call loadLighterSigner() first.')
  return checkErr(window.GenerateAPIKey(), 'GenerateAPIKey')
}

export function createLighterClient(
  baseUrl: string,
  privateKeyHex: string,
  chainId: number,
  apiKeyIndex: number,
  accountIndex: number,
): void {
  if (!window.CreateClient) throw new Error('Lighter signer not loaded — call loadLighterSigner() first.')
  checkErr(window.CreateClient(baseUrl, privateKeyHex, chainId, apiKeyIndex, accountIndex), 'CreateClient')
}

export function signChangePubKey(
  publicKeyHex: string,
  nonce: number,
  apiKeyIndex: number,
  accountIndex: number,
): { txType: number; txInfo: string; txHash: string; messageToSign: string } {
  if (!window.SignChangePubKey) throw new Error('Lighter signer not loaded — call loadLighterSigner() first.')
  // skipNonce is always 0 here — registration uses a real, server-assigned nonce.
  return checkErr(window.SignChangePubKey(publicKeyHex, 0, nonce, apiKeyIndex, accountIndex), 'SignChangePubKey')
}

// Order types / time-in-force from the Lighter signer's constants (types/txtypes/constants.go).
export const ORDER_TYPE_MARKET = 1
export const TIF_IMMEDIATE_OR_CANCEL = 0

// Sign a create-order tx. Arg order is the signer's fixed 19-arg contract, verified this
// session against the compiled WASM. For a MARKET order: orderType=1, timeInForce=0,
// orderExpiry=0 and triggerPrice=0 (the signer validates market orders require exactly
// these). `price` is the avg-execution cap (slippage-bounded), scaled to price decimals.
export function signCreateOrder(args: {
  marketIndex: number
  clientOrderIndex: number
  baseAmount: number
  price: number
  isAsk: number // 0 = buy/long, 1 = sell/short
  reduceOnly?: boolean // true when closing/reducing an existing position
  nonce: number
  apiKeyIndex: number
  accountIndex: number
}): { txType: number; txInfo: string; txHash: string } {
  if (!window.SignCreateOrder) throw new Error('Lighter signer not loaded — call loadLighterSigner() first.')
  return checkErr(
    window.SignCreateOrder(
      args.marketIndex,
      args.clientOrderIndex,
      args.baseAmount,
      args.price,
      args.isAsk,
      ORDER_TYPE_MARKET, // orderType
      TIF_IMMEDIATE_OR_CANCEL, // timeInForce
      args.reduceOnly ? 1 : 0, // reduceOnly
      0, // triggerPrice (Nil)
      0, // orderExpiry (Nil — required for market orders)
      0, // integratorAccountIndex (Nil)
      0, // integratorTakerFee (Nil)
      0, // integratorMakerFee (Nil)
      0, // selfTradeBehaviorMode (default)
      0, // selfTradeEqualityMode (default)
      0, // skipNonce
      args.nonce,
      args.apiKeyIndex,
      args.accountIndex,
    ),
    'SignCreateOrder',
  )
}

// Sign an update-leverage tx (7-arg contract). `fraction` is the initial-margin fraction
// in basis points (e.g. 2000 = 20% = 5x, 5000 = 50% = 2x). marginMode 0 = cross.
export function signUpdateLeverage(args: {
  marketIndex: number
  fraction: number
  nonce: number
  apiKeyIndex: number
  accountIndex: number
}): { txType: number; txInfo: string; txHash: string } {
  if (!window.SignUpdateLeverage) throw new Error('Lighter signer not loaded — call loadLighterSigner() first.')
  return checkErr(
    window.SignUpdateLeverage(args.marketIndex, args.fraction, 0, 0, args.nonce, args.apiKeyIndex, args.accountIndex),
    'SignUpdateLeverage',
  )
}
