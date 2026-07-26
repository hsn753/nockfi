import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { getLiquidationProtectionSettings, getRecentLiquidationProtectionEvents } from '@/lib/db/liquidation-protection'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address') || ''
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  try {
    await requireAuthenticatedWallet(req, address)
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }

  try {
    const [settings, events] = await Promise.all([
      getLiquidationProtectionSettings(address),
      getRecentLiquidationProtectionEvents(address, 20),
    ])
    return NextResponse.json({
      enabled: settings?.enabled ?? false,
      triggerLtvPct: settings?.triggerLtvPct ?? '85',
      targetLtvPct: settings?.targetLtvPct ?? '65',
      lastCheckedAt: settings?.lastCheckedAt ?? null,
      events,
    })
  } catch (err) {
    console.error('[liquidation-protection/status]', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
