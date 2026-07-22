import { NextRequest, NextResponse } from 'next/server'
import { withRateLimit } from '@/lib/api-guard'
import { getHoudiniOrder, houdiniStatusLabel, houdiniEnabled } from '@/lib/houdini'

export const dynamic = 'force-dynamic'

// Read-only status poll for a cross-chain funding order (by houdiniId), so the client can
// show progress until the USDG lands on Robinhood Chain.
export const GET = withRateLimit('houdini-status', 60, 60_000, handleGET)

async function handleGET(req: NextRequest) {
  if (!houdiniEnabled()) {
    return NextResponse.json({ error: 'Cross-chain funding is not enabled right now.' }, { status: 503 })
  }
  const houdiniId = req.nextUrl.searchParams.get('houdiniId')
  if (!houdiniId) {
    return NextResponse.json({ error: 'Missing houdiniId' }, { status: 400 })
  }
  try {
    const order = await getHoudiniOrder(houdiniId)
    const s = houdiniStatusLabel(order.status)
    return NextResponse.json({
      houdiniId: order.houdiniId,
      status: order.status,
      label: s.label,
      done: s.done,
      failed: s.failed,
      outAmount: order.outAmount ?? null,
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    console.error('[/api/houdini/status]', e?.message)
    return NextResponse.json({ error: e?.message || 'Failed to read order status' }, { status: e?.status || 500 })
  }
}
