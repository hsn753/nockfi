'use client'

import { useState, useEffect } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { Loader2, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

type ActivityEntry = {
  hash: string
  label: string
  detail: string
  status: 'success' | 'failed' | 'pending'
  timestamp: string
  explorerUrl: string
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function LiveActivity() {
  const { ready, authenticated } = usePrivy()
  const { wallets } = useWallets()
  const address = wallets[0]?.address

  const [activity, setActivity] = useState<ActivityEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState(false)

  useEffect(() => {
    if (!ready || !authenticated || !address) {
      setActivity(null)
      setFetchError(false)
      return
    }

    let cancelled = false

    // Fetch now, then poll so the feed stays current without a page reload — it fetched
    // only once on mount before, so anything done after opening the tab never appeared.
    const load = (isFirst: boolean) => {
      if (isFirst) {
        setLoading(true)
        setFetchError(false)
      }
      fetch(`/api/activity?address=${encodeURIComponent(address)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json() as Promise<{ activity: ActivityEntry[] }>
        })
        .then(({ activity: data }) => {
          if (!cancelled) {
            setActivity(data)
            setFetchError(false)
          }
        })
        .catch(() => {
          // Only surface an error on the very first load; a failed background poll keeps
          // the last good data on screen rather than flashing an error.
          if (!cancelled && isFirst) setFetchError(true)
        })
        .finally(() => {
          if (!cancelled && isFirst) setLoading(false)
        })
    }

    load(true)
    const interval = setInterval(() => load(false), 20_000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [ready, authenticated, address])

  if (!ready || !authenticated || !address) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
        <p className="text-sm font-medium text-foreground">No wallet connected</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Connect a wallet to see your on-chain activity.
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (fetchError || !activity) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
        <p className="text-sm font-medium text-foreground">Could not load activity</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Check your connection and try refreshing.
        </p>
      </div>
    )
  }

  if (activity.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
        <p className="text-sm font-medium text-foreground">No activity yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Transactions on Robinhood Chain will show up here.
        </p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col p-4">
      {activity.map((a, i) => (
        <li
          key={a.hash}
          className={cn(
            'flex items-start justify-between gap-3 py-4',
            i !== activity.length - 1 && 'border-b border-border/60',
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-foreground">{a.label}</p>
              {a.status !== 'success' && (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    a.status === 'failed' ? 'bg-destructive/20 text-destructive' : 'bg-secondary text-muted-foreground',
                  )}
                >
                  {a.status === 'failed' ? 'Reverted' : 'Pending'}
                </span>
              )}
            </div>
            {a.detail && <p className="mt-0.5 truncate text-xs text-muted-foreground">{a.detail}</p>}
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs text-muted-foreground">{relativeTime(a.timestamp)}</p>
            <a
              href={a.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-primary"
            >
              View <ExternalLink className="size-3" />
            </a>
          </div>
        </li>
      ))}
    </ul>
  )
}
