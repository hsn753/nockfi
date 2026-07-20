import { createWalletClient, custom } from 'viem'
import { nockChain } from './chain'
import {
  LIGHTER_BASE,
  LIGHTER_CHAIN_ID,
  resolveLighterMarket,
  getLighterNextNonce,
  submitLighterTx,
  getLighterPosition,
} from './lighter-account'
import { loadStoredKeyMeta, unlockPrivateKey, buildWrapMessage } from './lighter-key-storage'
import { loadLighterSigner, createLighterClient, signCreateOrder, signUpdateLeverage } from './lighter-wasm-client'

// Phase 4 — client-side perps order placement. The whole point of the non-custodial
// rebuild: the user's own Lighter API key (unlocked from encrypted local storage with a
// single wallet signature) signs a market order IN THE BROWSER and submits it straight
// to Lighter. Nock's servers never sign, never hold the key, and are not in the loop.
//
// Because the browser is the caller, Lighter's own IP geoblock enforces jurisdiction —
// a restricted-region user's order is rejected by Lighter with code 20558, which we
// surface verbatim. That is the geofence doing its job, not a bug to work around.

// Minimal shape of a Privy wallet — just what we need to build a viem wallet client.
type PrivyWalletLike = {
  address: string
  getEthereumProvider: () => Promise<unknown>
}

export type PlacePerpsOrderArgs = {
  walletAddress: string
  activeWallet: PrivyWalletLike
  symbol: string
  side: 'long' | 'short'
  marginUsd: number
  leverage: number
  markPrice: number
  maxSlippageBps?: number
  // When true, CLOSE the existing position at market (reduce-only). marginUsd/leverage
  // are ignored — the full current position size is closed in the opposite direction.
  reduceOnly?: boolean
}

export type PlacePerpsOrderResult =
  | { ok: true; orderId: string; avgPrice: number; baseFilled: number; notionalUsd: number }
  | { ok: false; error: string }

// Whether this wallet has a registered client-side Lighter key. The Confirm handler uses
// this to decide between the client path and the legacy executor.
export function hasClientPerpsKey(walletAddress: string): boolean {
  return loadStoredKeyMeta(walletAddress) !== null
}

export async function placeClientPerpsOrder(args: PlacePerpsOrderArgs): Promise<PlacePerpsOrderResult> {
  try {
    const meta = loadStoredKeyMeta(args.walletAddress)
    if (!meta) {
      return { ok: false, error: 'No trading key set up for this wallet. Set one up in Settings → Perps trading key first.' }
    }
    if (!(args.markPrice > 0)) {
      return { ok: false, error: 'Invalid order parameters.' }
    }
    if (!args.reduceOnly && (!(args.marginUsd > 0) || !(args.leverage >= 1))) {
      return { ok: false, error: 'Invalid order parameters.' }
    }

    // Unlock the API private key: one wallet signature over a fixed message re-derives the
    // AES key and decrypts the stored blob. No key material ever leaves the browser.
    const provider = await args.activeWallet.getEthereumProvider()
    const walletClient = createWalletClient({
      account: args.walletAddress as `0x${string}`,
      chain: nockChain,
      transport: custom(provider as Parameters<typeof custom>[0]),
    })
    const wrapSignature = await walletClient.signMessage({
      account: args.walletAddress as `0x${string}`,
      message: buildWrapMessage(args.walletAddress),
    })
    const privateKey = await unlockPrivateKey({ walletAddress: args.walletAddress, wrapSignature })

    await loadLighterSigner()

    const market = await resolveLighterMarket(args.symbol)
    const slip = (args.maxSlippageBps ?? 50) / 1e4
    createLighterClient(LIGHTER_BASE, privateKey, LIGHTER_CHAIN_ID, meta.apiKeyIndex, meta.accountIndex)

    // --- CLOSE / reduce-only: sell the full existing position at market, opposite side ---
    if (args.reduceOnly) {
      const pos = await getLighterPosition(meta.accountIndex, market.marketId)
      if (!pos || Math.abs(pos.signedSize) === 0) {
        return { ok: false, error: `You have no open ${args.symbol} position to close.` }
      }
      const closeIsAsk = pos.signedSize > 0 ? 1 : 0 // long -> sell to close
      const baseAmount = Math.round(Math.abs(pos.signedSize) * 10 ** market.sizeDecimals)
      const priceCap = args.markPrice * (closeIsAsk ? 1 - slip : 1 + slip)
      const price = Math.round(priceCap * 10 ** market.priceDecimals)
      const nonce = await getLighterNextNonce(meta.accountIndex, meta.apiKeyIndex)
      const clientOrderIndex = Math.max(1, Math.floor(Date.now() / 1000) % 2_000_000)
      const signed = signCreateOrder({
        marketIndex: market.marketId,
        clientOrderIndex,
        baseAmount,
        price,
        isAsk: closeIsAsk,
        reduceOnly: true,
        nonce,
        apiKeyIndex: meta.apiKeyIndex,
        accountIndex: meta.accountIndex,
      })
      const res = await submitLighterTx(signed.txType, signed.txInfo)
      if (!res.ok) return { ok: false, error: res.message }
      return {
        ok: true,
        orderId: signed.txHash,
        avgPrice: pos.avgEntryPrice || priceCap,
        baseFilled: Math.abs(pos.signedSize),
        notionalUsd: Math.abs(pos.positionValue),
      }
    }

    // --- OPEN: size from notional / mark, in the market's base units ---
    const notionalUsd = args.marginUsd * args.leverage
    const baseUnits = notionalUsd / args.markPrice
    if (baseUnits < market.minBaseAmount) {
      return {
        ok: false,
        error: `Order size ${baseUnits.toFixed(market.sizeDecimals)} ${args.symbol} is below Lighter's minimum of ${market.minBaseAmount} ${args.symbol}. Increase your margin or leverage.`,
      }
    }
    const baseAmount = Math.round(baseUnits * 10 ** market.sizeDecimals)

    // Market order needs a price cap (avg execution price): pay up to +slippage on a buy,
    // accept down to -slippage on a sell.
    const isAsk = args.side === 'short' ? 1 : 0
    const priceCap = args.markPrice * (isAsk ? 1 - slip : 1 + slip)
    const price = Math.round(priceCap * 10 ** market.priceDecimals)

    // Set the market's leverage to honor the requested value (IMF in basis points:
    // 10000/leverage, e.g. 5x -> 2000 = 20%). Skipped values default to 2x, which would
    // reject an order sized above 2x. Submitted first, then the order.
    const imfBps = Math.round(10000 / args.leverage)
    const levNonce = await getLighterNextNonce(meta.accountIndex, meta.apiKeyIndex)
    const levSigned = signUpdateLeverage({
      marketIndex: market.marketId,
      fraction: imfBps,
      nonce: levNonce,
      apiKeyIndex: meta.apiKeyIndex,
      accountIndex: meta.accountIndex,
    })
    const levResult = await submitLighterTx(levSigned.txType, levSigned.txInfo)
    if (!levResult.ok) {
      // A geoblock (20558) or any other rejection stops here — nothing was opened.
      return { ok: false, error: levResult.message }
    }

    // Fresh nonce after the leverage tx, then the market order.
    await new Promise((r) => setTimeout(r, 1500))
    const orderNonce = await getLighterNextNonce(meta.accountIndex, meta.apiKeyIndex)
    const clientOrderIndex = Math.max(1, Math.floor(Date.now() / 1000) % 2_000_000)
    const orderSigned = signCreateOrder({
      marketIndex: market.marketId,
      clientOrderIndex,
      baseAmount,
      price,
      isAsk,
      nonce: orderNonce,
      apiKeyIndex: meta.apiKeyIndex,
      accountIndex: meta.accountIndex,
    })
    const orderResult = await submitLighterTx(orderSigned.txType, orderSigned.txInfo)
    if (!orderResult.ok) {
      return { ok: false, error: orderResult.message }
    }

    // Poll briefly for the real fill so the confirmation shows true entry/size rather than
    // the pre-trade estimate. Market orders fill within a batch or two.
    let avgPrice = priceCap
    let baseFilled = baseUnits
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 2500))
      const pos = await getLighterPosition(meta.accountIndex, market.marketId)
      if (pos && Math.abs(pos.signedSize) > 0) {
        avgPrice = pos.avgEntryPrice || avgPrice
        baseFilled = Math.abs(pos.signedSize)
        break
      }
    }

    return {
      ok: true,
      orderId: orderSigned.txHash,
      avgPrice,
      baseFilled,
      notionalUsd: baseFilled * avgPrice,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Order placement failed.' }
  }
}
