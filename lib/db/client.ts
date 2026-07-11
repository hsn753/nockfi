import { drizzle } from 'drizzle-orm/neon-http'
import { neon } from '@neondatabase/serverless'
import * as schema from './schema'

// Lazy singleton, same pattern as getOpenAI() in app/api/robin/route.ts and
// getPrivyClient() in lib/privy-server.ts — avoids eager instantiation during Next.js's
// build-time page-data-collection phase, before env vars are guaranteed to be in scope.
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb() {
  if (!db) {
    const connectionString = process.env.POSTGRES_URL
    if (!connectionString) throw new Error('POSTGRES_URL not configured')
    const sql = neon(connectionString)
    db = drizzle(sql, { schema })
  }
  return db
}
