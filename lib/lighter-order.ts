import { createWalletClient, custom } from 'viem'
import { nockChain } from './chain'
import {
  LIGHTER_BASE,
  LIGHTER_CHAIN_ID,
  resolveLighterMarket,
  getLighterNextNonce,
  submitLighterTx,
  getLighterPosition,
  getLighterAccountBalance,
} from './lighter-account'
import { loadStoredKeyMeta, unlockPrivateKey, buildWrapMessage } from './lighter-key-storage'
import { cleanTxError } from './tx-error'
import { loadLighterSigner, createLighterClient, signCreateOrder, signUpdateLeverage, signWithdraw } from './lighter-wasm-client'

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
  // Fraction (0-1) of the position to close when reduceOnly. Omitted/>=1 = full close;
  // e.g. 0.5 trims half. Below the venue min it's rejected with a clear message.
  reducePct?: number
}

export type PlacePerpsOrderResult =
  | { ok: true; orderId: string; avgPrice: number; baseFilled: number; notionalUsd: number }
  | { ok: false; error: string }

// Whether this wallet has a registered client-side Lighter key. The Confirm handler uses
// this to decide between the client path and the legacy executor.
export function hasClientPerpsKey(walletAddress: string): boolean {
  return loadStoredKeyMeta(walletAddress) !== null
}

export type WithdrawResult = { ok: true } | { ok: false; error: string }

// Withdraw USDG from the perps (Lighter) account back to the user's wallet. Signs a
// withdraw tx IN THE BROWSER with the user's own key; funds can only return to their own
// L1 address (the signer has no recipient param). Requires a registered key.
export async function withdrawPerpsFunds(args: {
  walletAddress: string
  activeWallet: PrivyWalletLike
  amountUsdg: number
}): Promise<WithdrawResult> {
  try {
    const meta = loadStoredKeyMeta(args.walletAddress)
    if (!meta) {
      return { ok: false, error: 'No trading key on this device. Set one up in Settings → Perps trading key first.' }
    }
    if (!(args.amountUsdg > 0)) {
      return { ok: false, error: 'Enter a positive USDG amount to withdraw.' }
    }

    // Only free (available) margin can be withdrawn — margin backing an open position can't.
    const bal = await getLighterAccountBalance(meta.accountIndex)
    if (bal && args.amountUsdg > bal.availableUsd + 1e-6) {
      return {
        ok: false,
        error: `You can withdraw up to $${bal.availableUsd.toFixed(2)} — that's the free margin in your perps account. ${bal.availableUsd < bal.collateralUsd ? 'The rest is backing an open position; close it first to free it up.' : ''}`.trim(),
      }
    }

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
    createLighterClient(LIGHTER_BASE, privateKey, LIGHTER_CHAIN_ID, meta.apiKeyIndex, meta.accountIndex)

    const nonce = await getLighterNextNonce(meta.accountIndex, meta.apiKeyIndex)
    const signed = signWithdraw({
      amountUsdg: args.amountUsdg,
      nonce,
      apiKeyIndex: meta.apiKeyIndex,
      accountIndex: meta.accountIndex,
    })
    const res = await submitLighterTx(signed.txType, signed.txInfo)
    if (!res.ok) return { ok: false, error: res.message }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: cleanTxError(err) }
  }
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

    // --- CLOSE / reduce-only: sell the existing position at market, opposite side. A
    //     reducePct < 1 trims only part of it (partial close / take some off). ---
    if (args.reduceOnly) {
      const pos = await getLighterPosition(meta.accountIndex, market.marketId)
      if (!pos || Math.abs(pos.signedSize) === 0) {
        return { ok: false, error: `You have no open ${args.symbol} position to close.` }
      }
      const closeIsAsk = pos.signedSize > 0 ? 1 : 0 // long -> sell to close
      const fullSize = Math.abs(pos.signedSize)
      const fraction = args.reducePct != null ? Math.min(1, Math.max(0, args.reducePct)) : 1
      const fullBaseAmount = Math.round(fullSize * 10 ** market.sizeDecimals)
      let baseAmount = fraction >= 1 ? fullBaseAmount : Math.round(fullSize * fraction * 10 ** market.sizeDecimals)
      const minBaseAmount = Math.round(market.minBaseAmount * 10 ** market.sizeDecimals)
      if (baseAmount <= 0) {
        return { ok: false, error: 'That amount is too small to close.' }
      }
      // A partial close below the venue minimum can't be placed — tell them to trim more
      // or close fully. (A full close is always allowed even if the position < min.)
      if (fraction < 1 && baseAmount < minBaseAmount) {
        return {
          ok: false,
          error: `That's below Lighter's minimum order size (${market.minBaseAmount} ${args.symbol}). Close a larger amount, or close the whole position.`,
        }
      }
      if (baseAmount > fullBaseAmount) baseAmount = fullBaseAmount
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
      const closedSize = baseAmount / 10 ** market.sizeDecimals
      return {
        ok: true,
        orderId: signed.txHash,
        avgPrice: pos.avgEntryPrice || priceCap,
        baseFilled: closedSize,
        notionalUsd: Math.abs(pos.positionValue) * (closedSize / fullSize),
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

    // Margin pre-check. Lighter ACCEPTS an under-margined order tx (200) but then never
    // fills it — so without this the app would report a phantom "position opened". Refuse
    // up front with a clear, honest reason instead.
    const bal = await getLighterAccountBalance(meta.accountIndex)
    if (bal && bal.availableUsd + 1e-6 < args.marginUsd) {
      return {
        ok: false,
        error: `Not enough perps margin: your perps balance has $${bal.availableUsd.toFixed(2)} available, but this position needs $${args.marginUsd.toFixed(2)} of margin. Add funds to your perps account (Settings → Perps trading key → Add funds), or try a smaller size.`,
      }
    }
    // Snapshot the position before the order so we can confirm it actually grew (filled).
    const beforePos = await getLighterPosition(meta.accountIndex, market.marketId)
    const beforeSigned = beforePos?.signedSize ?? 0

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

    // Poll for the position to actually reflect the fill — the order tx being accepted
    // (200) does NOT mean it filled. Confirm the position grew in the intended direction;
    // if it never does, the order did not fill and we must NOT report a phantom success.
    let filled: Awaited<ReturnType<typeof getLighterPosition>> = null
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 2500))
      const pos = await getLighterPosition(meta.accountIndex, market.marketId)
      const nowSigned = pos?.signedSize ?? 0
      const grew = isAsk ? nowSigned < beforeSigned - 1e-9 : nowSigned > beforeSigned + 1e-9
      if (pos && grew) {
        filled = pos
        break
      }
    }
    if (!filled) {
      return {
        ok: false,
        error:
          "The order didn't fill — this usually means not enough margin in your perps account for this size, or thin liquidity right now. Nothing was opened. Add funds or try a smaller size/lower leverage.",
      }
    }

    return {
      ok: true,
      orderId: orderSigned.txHash,
      avgPrice: filled.avgEntryPrice || priceCap,
      baseFilled: Math.abs(filled.signedSize),
      notionalUsd: Math.abs(filled.positionValue),
    }
  } catch (err) {
    return { ok: false, error: cleanTxError(err) }
  }
}
