import { NextResponse } from 'next/server'
import { resolveGasTopUp } from '@/lib/yield-automation'

// No auth needed — this reveals nothing user-specific, just whether OUR OWN shared
// automation address currently needs a small gas top-up. Called by the client right after
// a user grants/renews automation authorization (Settings toggles), alongside the
// equivalent chat-card path in app/api/robin/route.ts.
export async function GET() {
  const topUp = await resolveGasTopUp()
  return NextResponse.json({ topUp })
}
