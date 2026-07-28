import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { withRateLimit } from '@/lib/api-guard'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { getHoudiniQuote, getHoudiniPrivateQuote, createHoudiniExchange, HOUDINI_ASSETS, ROBINHOOD_ETH, houdiniEnabled, type HoudiniDirection, type RobinhoodAssetKey, type HoudiniRouteType } from '@/lib/houdini'

export const dynamic = 'force-dynamic'

// Creates a Houdini order (fund-IN or cash-OUT) and returns the SIGN-chain transaction the
// user signs, plus which token/chain to sign on. Re-quotes fresh here so the order is
// created against a live rate; the client then signs immediately. The KEY:CODE secret lives
// only in lib/houdini — never sent to the browser.
export const POST = withRateLimit('houdini-create', 5, 60_000, handlePOST)

async function handlePOST(req: NextRequest) {
  if (!houdiniEnabled()) {
    return NextResponse.json({ error: 'Cross-chain funding is not enabled right now.' }, { status: 503 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    assetKey?: string
    sourceKey?: string // legacy alias for assetKey (inbound)
    direction?: HoudiniDirection
    amount?: string | number
    addressFrom?: string
    addressTo?: string
    robinhoodAsset?: RobinhoodAssetKey
    routeType?: HoudiniRouteType
    // Private sends carry resolved Houdini token ids instead of an assetKey, so they can
    // target any of the ~100 supported chains and their token lists.
    fromTokenId?: string
    toTokenId?: string
  }
  const assetKey = body.assetKey || body.sourceKey
  const direction: HoudiniDirection = body.direction === 'out' ? 'out' : 'in'
  const { addressFrom, addressTo, fromTokenId, toTokenId } = body
  const amount = Number(body.amount)
  const robinhoodAsset: RobinhoodAssetKey = body.robinhoodAsset === 'ETH' ? 'ETH' : 'USDG'
  // 'private' routes through Houdini's anonymity tier: nothing to sign, the client
  // transfers to the returned depositAddress instead. addressTo is a real recipient here
  // (deliberately NOT the sender — delivering back to the sender defeats the privacy).
  const routeType: HoudiniRouteType = body.routeType === 'private' ? 'private' : 'standard'
  const isTokenIdPrivate = routeType === 'private' && !!fromTokenId && !!toTokenId

  if (!isTokenIdPrivate && (!assetKey || !HOUDINI_ASSETS[assetKey])) {
    return NextResponse.json({ error: 'Unsupported or missing assetKey' }, { status: 400 })
  }
  if (!amount || amount <= 0 || !isFinite(amount)) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
  }
  if (!addressFrom || !isAddress(addressFrom)) {
    return NextResponse.json({ error: 'Invalid addressFrom' }, { status: 400 })
  }
  // The recipient of a private send can be on a non-EVM chain (Solana, Bitcoin), so an
  // EVM-shaped check would wrongly reject it. The chat layer already validated it against
  // the destination chain's own published regex; here just require a plausible value.
  if (isTokenIdPrivate) {
    if (!addressTo || addressTo.trim().length < 20) {
      return NextResponse.json({ error: 'Invalid addressTo' }, { status: 400 })
    }
  } else if (!addressTo || !isAddress(addressTo)) {
    return NextResponse.json({ error: 'Invalid addressTo' }, { status: 400 })
  }

  // The order is scoped to the caller's own wallet — verify they control addressFrom.
  try {
    await requireAuthenticatedWallet(req, addressFrom)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }

  try {
    const country =
      req.headers.get('x-vercel-ip-country') || req.headers.get('cf-ipcountry') || req.headers.get('x-country-code') || undefined
    // Private sends re-quote by token id (any chain/token); standard flows use the fixed
    // asset map. Either way the order is created against a freshly fetched rate.
    const { best, sign } = isTokenIdPrivate
      ? {
          best: await getHoudiniPrivateQuote({
            fromTokenId: fromTokenId!, toTokenId: toTokenId!, amount,
            sellSymbol: ROBINHOOD_ETH.symbol, country: country || undefined,
          }),
          // The sell side of a private send is always the user's Robinhood-native ETH.
          sign: { chainId: ROBINHOOD_ETH.chainId, address: ROBINHOOD_ETH.address, decimals: ROBINHOOD_ETH.decimals, symbol: ROBINHOOD_ETH.symbol },
        }
      : await getHoudiniQuote(assetKey!, amount, direction, country || undefined, robinhoodAsset, routeType)
    const order = await createHoudiniExchange(best.quoteId, addressFrom, addressTo)
    // A private order is useless without a deposit address — fail loudly rather than
    // handing the client an order it can't act on.
    if (routeType === 'private' && !order.depositAddress) {
      return NextResponse.json({ error: 'Houdini did not return a deposit address for this private route. Nothing was sent; please try again.' }, { status: 502 })
    }
    // Log the order id: once a user has deposited, this is the ONLY handle for tracing a
    // transfer that hasn't landed, and nothing else server-side records it (a real support
    // dead end the first time someone asked "where are my funds?"). No secrets here — the
    // addresses are the user's own and the id is what Houdini's own support asks for.
    console.log('[/api/houdini/create] order created', JSON.stringify({
      houdiniId: order.houdiniId, routeType, direction, assetKey, robinhoodAsset,
      amount, addressFrom, addressTo, depositAddress: order.depositAddress ?? null,
    }))
    return NextResponse.json({
      houdiniId: order.houdiniId,
      status: order.status,
      metadata: order.metadata ?? null,
      depositAddress: order.depositAddress ?? null,
      expires: order.expires ?? null,
      routeType,
      // The token + chain the client must sign on (approve + bridge tx, or the plain
      // transfer to depositAddress on a private route).
      sign: { chainId: sign.chainId, address: sign.address, decimals: sign.decimals, symbol: sign.symbol },
      amountIn: order.inAmount ?? amount,
      amountOut: order.outAmount ?? best.netAmountOut ?? best.amountOut,
      requiresApproval: routeType === 'private' ? false : (best.requiresApproval ?? true),
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    console.error('[/api/houdini/create]', e?.message)
    return NextResponse.json({ error: e?.message || 'Failed to create funding order' }, { status: e?.status || 500 })
  }
}
