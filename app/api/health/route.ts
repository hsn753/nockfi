import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    version: process.env.VERCEL_GIT_COMMIT_SHA?.substring(0, 7) || 'dev',
    timestamp: new Date().toISOString(),
    deployment: process.env.VERCEL_URL || 'local',
  })
}
