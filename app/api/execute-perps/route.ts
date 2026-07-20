import { NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { resolvePerpsGeo } from '@/lib/geo-gate'
import { executePerpsOrder } from '@/lib/lighter-execute'

export const dynamic = 'force-dynamic'

// Perps execution endpoint — the server-side counterpart to the client's Confirm button.
// Unlike a swap (which the user's own wallet signs client-side), a Lighter perps order is
// signed by the isolated executor service, so it MUST run server-side. Called only from the
// perps preview card's Confirm handler with the card's structured order params.
//
// Every gate is re-checked here, never trusting that propose_action already checked: the
// caller's Privy session is verified and bound to the claimed wallet, the jurisdiction is
// re-resolved from THIS request (fail-closed), and executePerpsOrder re-applies the flag,
// geofence, notional cap, and executor-provisioning gates before anything reaches Lighter.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }
    const { walletAddress, symbol, side, marginUsd, leverage, markPrice, maxSlippageBps } = body as {
      walletAddress?: string
      symbol?: string
      side?: string
      marginUsd?: number
      leverage?: number
      markPrice?: number
      maxSlippageBps?: number
    }

    if (!walletAddress || !isAddress(walletAddress)) {
      return NextResponse.json({ error: 'A connected wallet is required.' }, { status: 400 })
    }
    if (
      !symbol ||
      (side !== 'long' && side !== 'short') ||
      !(Number(marginUsd) > 0) ||
      !(Number(leverage) >= 1) ||
      !(Number(markPrice) > 0)
    ) {
      return NextResponse.json({ error: 'Invalid perps order parameters.' }, { status: 400 })
    }

    // Bind the Privy session to the claimed wallet (throws AuthError otherwise).
    await requireAuthenticatedWallet(req, walletAddress)

    // Re-resolve jurisdiction from THIS request — the geofence is the safeguard and must
    // never be skipped just because a card was previewed earlier.
    const geo = await resolvePerpsGeo(req)

    const exec = await executePerpsOrder(
      {
        walletAddress,
        symbol,
        side,
        marginUsd: Number(marginUsd),
        leverage: Number(leverage),
        markPrice: Number(markPrice),
        maxSlippageBps: maxSlippageBps != null ? Number(maxSlippageBps) : undefined,
      },
      geo,
    )

    if (!exec.ok) {
      const status =
        exec.code === 'geo_blocked'
          ? 403
          : exec.code === 'disabled' || exec.code === 'not_provisioned'
          ? 503
          : exec.code === 'executor_error'
          ? 502
          : 400
      return NextResponse.json({ error: exec.error, code: exec.code }, { status })
    }

    return NextResponse.json({
      orderId: exec.orderId,
      avgPrice: exec.avgPrice,
      baseFilled: exec.baseFilled,
      notionalUsd: exec.notionalUsd,
    })
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('[execute-perps] error:', err)
    return NextResponse.json({ error: 'Perps execution failed. Nothing was placed.' }, { status: 500 })
  }
}
