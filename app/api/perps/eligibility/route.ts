import { NextResponse } from 'next/server'
import { resolvePerpsGeo, PERPS_RESTRICTED_LABEL } from '@/lib/geo-gate'

export const dynamic = 'force-dynamic'

// Lets the client know whether perps ONBOARDING (deposit + key setup) is allowed from the
// caller's region — the same jurisdiction geofence the trade path uses (lib/geo-gate.ts),
// resolved from THIS request's IP. Used to block a restricted-region user BEFORE they can
// deposit into a Lighter account they'd never be able to trade or register a key for
// (which would strand their funds). Fail-closed: undetermined region => not allowed.
export async function GET(req: Request) {
  const geo = await resolvePerpsGeo(req)
  return NextResponse.json({
    allowed: geo.allowed,
    country: geo.country,
    restrictedLabel: PERPS_RESTRICTED_LABEL,
  })
}
