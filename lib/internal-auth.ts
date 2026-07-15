// Shared verification for the MACHINE-only API namespaces (cron sweeps, one-time admin
// setup). These are server-to-server / operator calls that never touch the browser, so a
// shared server secret is the correct auth here (unlike the user-facing routes, which use
// per-user Privy identity tokens and can't be reduced to a static key).
//
// Edge-safe on purpose: pure JS, no Node `crypto` — the same helpers run in both
// middleware.ts (Edge runtime) and the route handlers (Node runtime), so the perimeter
// check and the in-handler check can never drift apart.

// Minimal shape shared by NextRequest and the route's request object.
type HeaderReader = { headers: { get(name: string): string | null } }

// Length-independent constant-time comparison. Avoids leaking secret length or contents
// via early-return timing. Practical value is modest for a network endpoint, but it's
// cheap and removes the timing side-channel the plain `!==` had.
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) {
    // Still touch every byte of the wrong-length input so work is ~constant, then fail.
    let sink = 0
    for (let i = 0; i < a.length; i++) sink |= a.charCodeAt(i)
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Cron sweep: Vercel injects `Authorization: Bearer ${CRON_SECRET}` on scheduled runs;
// the EC2 crontab sends the same. Fails CLOSED when the secret is unconfigured.
export function checkCronAuth(req: HeaderReader): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return timingSafeEqualStr(req.headers.get('authorization') ?? '', `Bearer ${secret}`)
}

// One-time admin setup (session-signer policy). Fails CLOSED when unconfigured.
export function checkAdminAuth(req: HeaderReader): boolean {
  const secret = process.env.ADMIN_SETUP_TOKEN
  if (!secret) return false
  return timingSafeEqualStr(req.headers.get('x-admin-token') ?? '', secret)
}
