import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { getYieldAutomationSettings, getRecentYieldAutomationEvents } from '@/lib/db/yield-automation'

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
      getYieldAutomationSettings(address),
      getRecentYieldAutomationEvents(address, 20),
    ])
    return NextResponse.json({
      enabled: settings?.enabled ?? false,
      minApyDeltaPct: settings?.minApyDeltaPct ?? null,
      authorizedAt: settings?.authorizedAt ?? null,
      lastCheckedAt: settings?.lastCheckedAt ?? null,
      events,
    })
  } catch (err) {
    console.error('[yield-automation/status]', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
