import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { withRateLimit } from '@/lib/api-guard'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { getHoudiniQuote, createHoudiniExchange, HOUDINI_ASSETS, houdiniEnabled, type HoudiniDirection } from '@/lib/houdini'

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
  }
  const assetKey = body.assetKey || body.sourceKey
  const direction: HoudiniDirection = body.direction === 'out' ? 'out' : 'in'
  const { addressFrom, addressTo } = body
  const amount = Number(body.amount)

  if (!assetKey || !HOUDINI_ASSETS[assetKey]) {
    return NextResponse.json({ error: 'Unsupported or missing assetKey' }, { status: 400 })
  }
  if (!amount || amount <= 0 || !isFinite(amount)) {
    return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
  }
  if (!addressFrom || !isAddress(addressFrom)) {
    return NextResponse.json({ error: 'Invalid addressFrom' }, { status: 400 })
  }
  if (!addressTo || !isAddress(addressTo)) {
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
    const { best, sign } = await getHoudiniQuote(assetKey, amount, direction, country || undefined)
    const order = await createHoudiniExchange(best.quoteId, addressFrom, addressTo)
    return NextResponse.json({
      houdiniId: order.houdiniId,
      status: order.status,
      metadata: order.metadata ?? null,
      depositAddress: order.depositAddress ?? null,
      // The token + chain the client must sign on (approve + bridge tx).
      sign: { chainId: sign.chainId, address: sign.address, decimals: sign.decimals, symbol: sign.symbol },
      amountIn: order.inAmount ?? amount,
      amountOut: order.outAmount ?? best.netAmountOut,
      requiresApproval: best.requiresApproval ?? true,
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    console.error('[/api/houdini/create]', e?.message)
    return NextResponse.json({ error: e?.message || 'Failed to create funding order' }, { status: e?.status || 500 })
  }
}
