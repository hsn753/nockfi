// Jurisdiction geofence for the Perps Agent.
//
// Perpetual futures are prohibited for retail in a set of jurisdictions for REGULATORY
// reasons — CFTC (US) and CSA (Canada) treat them as leveraged derivatives that can't be
// offered to retail off a registered venue, and Lighter's own ToS + Robinhood's own perps
// product both geoblock the same regions. This is the app-side mirror of that: no live
// perps order may be born for a restricted jurisdiction, ever, regardless of the
// PERPS_ENABLED flag. It is deliberately FAIL-CLOSED — if we can't determine the country,
// we treat it as restricted, because under-serving an eligible user is recoverable and
// serving a restricted one is not.
//
// Enabling live perps is gated on a legal sign-off of this list (see the feasibility memo).
// Before going live at scale, wire a first-class geo source (platform header via Vercel/CF,
// or MaxMind on Caddy) rather than leaning on the IP-lookup fallback below.

// Union of Robinhood's perps-restricted list (US/CA/GB/CH/AE/SG — regulatory) and Lighter's
// ToS-prohibited list (sanctions + the above). ISO 3166-1 alpha-2, uppercase.
const PERPS_RESTRICTED = new Set([
  'US', 'CA', 'GB', 'CH', 'AE', 'SG', // regulatory (CFTC / CSA / FCA / FINMA / etc.)
  'CN', 'KP', 'RU', 'UA', 'CU', 'IR', 'VE', 'SD', 'BY', 'MM', 'SY', // sanctions / ToS
])

export type PerpsGeo = {
  country: string | null
  allowed: boolean
  // Where the country came from, for logging/debugging. 'header' is authoritative;
  // 'lookup' is the best-effort fallback; 'unknown' means we couldn't tell → blocked.
  source: 'header' | 'lookup' | 'unknown'
}

const BLOCKED_UNKNOWN: PerpsGeo = { country: null, allowed: false, source: 'unknown' }

function fromHeaders(req: Request): string | null {
  const h = req.headers
  // Vercel and Cloudflare both inject a trusted country header at their edge; these are the
  // authoritative source when present and cannot be spoofed by the client (the edge sets
  // them after its own geolocation). x-country-code is a manual override we could set at Caddy.
  const c =
    h.get('x-vercel-ip-country') ||
    h.get('cf-ipcountry') ||
    h.get('x-country-code') ||
    ''
  const up = c.trim().toUpperCase()
  // Cloudflare uses "XX" / "T1" for unknown/Tor; treat those as undetermined.
  return up && up !== 'XX' && up !== 'T1' && up.length === 2 ? up : null
}

function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return req.headers.get('x-real-ip') || req.headers.get('cf-connecting-ip') || null
}

// Best-effort IP → country for deployments without a trusted geo header (e.g. the EC2 origin
// behind Caddy). HTTPS, no API key. Any failure returns null so the caller fails CLOSED.
// Two independent providers, tried in order — this is a regulatory control, so a single
// provider outage must not silently open the gate (it fails closed, but redundancy keeps
// eligible users served). Before enabling perps at scale, replace with a trusted edge header
// (Vercel/Cloudflare) or a MaxMind DB at Caddy.
async function lookupCountry(ip: string): Promise<string | null> {
  const enc = encodeURIComponent(ip)
  // country.is — minimal JSON {"country":"US"}
  try {
    const res = await fetch(`https://api.country.is/${enc}`, { signal: AbortSignal.timeout(2500) })
    if (res.ok) {
      const code = String(((await res.json()) as { country?: string }).country || '').toUpperCase()
      if (/^[A-Z]{2}$/.test(code)) return code
    }
  } catch { /* fall through to backup */ }
  // ipwho.is — backup provider
  try {
    const res = await fetch(`https://ipwho.is/${enc}`, { signal: AbortSignal.timeout(2500) })
    if (res.ok) {
      const code = String(((await res.json()) as { country_code?: string }).country_code || '').toUpperCase()
      if (/^[A-Z]{2}$/.test(code)) return code
    }
  } catch { /* both failed → null → caller fails closed */ }
  return null
}

// Resolve the request's jurisdiction and whether perps are permitted there. Prefers the
// trusted edge header; falls back to an IP lookup; fails CLOSED (blocked) when undetermined.
export async function resolvePerpsGeo(req: Request): Promise<PerpsGeo> {
  const headerCountry = fromHeaders(req)
  if (headerCountry) {
    return { country: headerCountry, allowed: !PERPS_RESTRICTED.has(headerCountry), source: 'header' }
  }

  const ip = clientIp(req)
  // Loopback/private/unknown IPs can't be geolocated — block rather than guess.
  if (!ip || ip === 'unknown' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') || ip === '::1') {
    return BLOCKED_UNKNOWN
  }

  const looked = await lookupCountry(ip)
  if (!looked) return BLOCKED_UNKNOWN
  return { country: looked, allowed: !PERPS_RESTRICTED.has(looked), source: 'lookup' }
}

// Human-readable list of restricted regions, for messaging. Not exhaustive on purpose —
// names the ones a user is most likely to be in.
export const PERPS_RESTRICTED_LABEL = 'the US, Canada, UK, Switzerland, UAE, and Singapore'
