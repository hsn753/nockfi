import { NextResponse } from 'next/server'
import { consumeRateLimit } from './db/rate-limit'

// Route-level rate limiting. It lives in the handler (not Edge middleware) because this
// Next 16 + Turbopack build doesn't wire middleware into `next start` — and the counter
// is Postgres-backed (lib/db/rate-limit.ts) because in-process memory doesn't persist
// across requests in this runtime. Applied to the public / expensive endpoints (the
// unauthenticated reads + the LLM route), which are the easiest abuse surface.
//
// Fails OPEN: if the limiter's own DB check errors, the request is allowed rather than
// blocked — a limiter fault must never take down legitimate traffic.

type RouteHandler<T extends Request> = (req: T) => Promise<Response> | Response

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || 'unknown'
}

export function withRateLimit<T extends Request>(
  name: string,
  limit: number,
  windowMs: number,
  handler: RouteHandler<T>,
): RouteHandler<T> {
  return async (req: T) => {
    try {
      const { allowed } = await consumeRateLimit(name, clientIp(req), limit, windowMs, Date.now())
      if (!allowed) {
        return NextResponse.json(
          { error: 'Too many requests. Slow down and try again shortly.' },
          { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil(windowMs / 1000))) } },
        )
      }
    } catch (err) {
      console.error('[rate-limit] check failed, allowing request:', err)
    }
    return handler(req)
  }
}
