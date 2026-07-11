'use client'

import { LiveActivity } from './live-activity'

export function ActivityView() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-5">
        <div>
          <h1 className="text-sm font-semibold text-foreground">Activity</h1>
          <p className="text-xs text-muted-foreground">
            Real on-chain activity for your connected wallet
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-2 md:px-5">
          <LiveActivity />
        </div>
      </div>
    </div>
  )
}
