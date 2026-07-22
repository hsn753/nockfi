import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { withRateLimit } from '@/lib/api-guard'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { getHoudiniQuote, createHoudiniExchange, HOUDINI_SOURCES, houdiniEnabled } from '@/lib/houdini'

export const dynamic = 'force-dynamic'

// Creates a Houdini cross-chain funding order and returns the SOURCE-chain transaction the
// user signs (DEX/bridge route) or a deposit address (CEX route). Re-quotes fresh here so
// the order is created against a live rate, then the client signs immediately. The
// KEY:CODE secret lives only in lib/houdini — never sent to the browser.
export const POST = withRateLimit('houdini-create', 5, 60_000, handlePOST)

async function handlePOST(req: NextRequest) {
  if (!houdiniEnabled()) {
    return NextResponse.json({ error: 'Cross-chain funding is not enabled right now.' }, { status: 503 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    sourceKey?: string
    amount?: string | number
    addressFrom?: string
    addressTo?: string
  }
  const { sourceKey, addressFrom, addressTo } = body
  const amount = Number(body.amount)

  if (!sourceKey || !HOUDINI_SOURCES[sourceKey]) {
    return NextResponse.json({ error: 'Unsupported or missing sourceKey' }, { status: 400 })
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
    const { source, best } = await getHoudiniQuote(sourceKey, amount, country || undefined)
    const order = await createHoudiniExchange(best.quoteId, addressFrom, addressTo)
    return NextResponse.json({
      houdiniId: order.houdiniId,
      status: order.status,
      metadata: order.metadata ?? null,
      depositAddress: order.depositAddress ?? null,
      source: {
        chainId: source.chainId,
        address: source.address,
        decimals: source.decimals,
        symbol: source.symbol,
        label: source.label,
      },
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
