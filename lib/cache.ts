// Minimal per-process TTL cache for hot / shared server reads. Collapses the flood of
// identical polls that hit an instance within the window down to a single upstream read —
// the same module-singleton pattern the stock-registry (get-stock-tokens.ts) and nock-gate
// caches already rely on. Not a correctness cache: values are short-lived and refreshed
// after ttlMs, and a rejected fn is never cached (so a transient failure doesn't stick).
const store = new Map<string, { value: unknown; expiresAt: number }>()

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = store.get(key)
  if (hit && now < hit.expiresAt) return hit.value as T
  const value = await fn()
  store.set(key, { value, expiresAt: now + ttlMs })
  if (store.size > 5000) {
    for (const [k, v] of store) if (now >= v.expiresAt) store.delete(k)
  }
  return value
}
