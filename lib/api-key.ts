import { NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'crypto'
import { consumeRateLimit } from './db/rate-limit'

// Partner API-key auth for the public /api/v1 surface. Distinct from the per-user Privy auth
// (lib/auth-server.ts) that guards the app's own endpoints — a partner integrates with ONE
// key, not a login per end-user.
//
// Keys are never stored raw. PARTNER_API_KEYS holds `name:sha256hex` pairs (comma-separated);
// we hash the presented key and constant-time compare. Generate one with
// scripts/gen-partner-key.mjs, hand the raw key to the partner, add its hash to the env.

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function keyTable(): Array<{ name: string; hash: string }> {
  return (process.env.PARTNER_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf(':')
      return { name: pair.slice(0, i).trim(), hash: pair.slice(i + 1).trim().toLowerCase() }
    })
    .filter((e) => e.name && /^[a-f0-9]{64}$/.test(e.hash))
}

function eqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

// Returns the partner name for a valid key, or null. Accepts `x-api-key: <key>` or
// `Authorization: Bearer <key>`.
export function partnerFromApiKey(req: { headers: { get(name: string): string | null } }): string | null {
  const header = req.headers.get('x-api-key') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  const key = header.trim()
  if (!key) return null
  const presented = sha256Hex(key)
  for (const { name, hash } of keyTable()) {
    if (eqHex(presented, hash)) return name
  }
  return null
}

type Handler = (req: Request, partner: string) => Promise<Response> | Response

// Wrap a /api/v1 route: require a valid API key, then rate-limit PER KEY. Fails closed on a
// missing/invalid key (401); fails open only if the rate-limiter's own DB check errors, so a
// limiter fault never takes down a paying partner.
export function withApiKey(routeName: string, limit: number, windowMs: number, handler: Handler): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const partner = partnerFromApiKey(req)
    if (!partner) {
      return NextResponse.json(
        { error: 'Missing or invalid API key. Include your key in the x-api-key header.' },
        { status: 401 },
      )
    }
    try {
      const { allowed } = await consumeRateLimit(`v1:${routeName}`, partner, limit, windowMs, Date.now())
      if (!allowed) {
        return NextResponse.json(
          { error: 'Rate limit exceeded. Slow down or contact us to raise your limit.' },
          { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil(windowMs / 1000))) } },
        )
      }
    } catch {
      /* limiter DB error → fail open, same policy as withRateLimit */
    }
    return handler(req, partner)
  }
}
