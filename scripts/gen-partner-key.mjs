#!/usr/bin/env node
// Generate a partner API key for the /api/v1 surface.
//   node scripts/gen-partner-key.mjs <partner-name>
// Prints the RAW key (give it to the partner, once) and the HASH line to append to the
// PARTNER_API_KEYS env var (comma-separated). We only ever store the hash.
import { randomBytes, createHash } from 'node:crypto'

const name = (process.argv[2] || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
if (!name) {
  console.error('Usage: node scripts/gen-partner-key.mjs <partner-name>')
  process.exit(1)
}

const key = `npk_${randomBytes(24).toString('hex')}` // "nock partner key"
const hash = createHash('sha256').update(key).digest('hex')

console.log(`\nPartner:            ${name}`)
console.log(`API key (give once): ${key}`)
console.log(`\nAppend to PARTNER_API_KEYS (comma-separate multiple):`)
console.log(`  ${name}:${hash}\n`)
console.log('The raw key is not stored anywhere — copy it now.')
