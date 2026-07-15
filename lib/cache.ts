// Minimal per-process TTL cache for hot / shared server reads. Collapses the flood of
// identical polls that hit an instance within the window down to a single upstream read —
// the same module-singleton pattern the stock-registry (get-stock-tokens.ts) and nock-gate
// caches already rely on. Not a correctness cache: values are short-lived and refreshed
// after ttlMs, and a rejected fn is never cached (so a transient failure doesn't stick).
const store = new Map<string, { value: unknown; expiresAt: number }>()
// In-flight computations, keyed the same as store. Single-flight: when many requests miss
// the same key at once (a cold cache, or the moment a TTL expires under a poll storm), they
// all await ONE computation instead of stampeding the upstream (RPC/DB). Without this, a
// burst of 40 concurrent identical requests fired 40 cold computations at once.
const inflight = new Map<string, Promise<unknown>>()

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = store.get(key)
  if (hit && now < hit.expiresAt) return hit.value as T

  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>

  const p = (async () => {
    try {
      const value = await fn()
      store.set(key, { value, expiresAt: Date.now() + ttlMs })
      if (store.size > 5000) {
        const t = Date.now()
        for (const [k, v] of store) if (t >= v.expiresAt) store.delete(k)
      }
      return value
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, p)
  return p as Promise<T>
}
