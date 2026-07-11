'use client'

import { Bell, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type AttentionItem, type Position } from './data'
import { AgentIcon } from './agent-icon'
import { LiveBalances } from './live-balances'
import { LiveActivity } from './live-activity'

type DashTab = 'overview' | 'balances' | 'activity'

type Props = {
  tab: DashTab
  onTabChange: (t: DashTab) => void
  attention: AttentionItem[]
  positions: Position[]
  portfolioValue: string
}

const tabs: { id: DashTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'balances', label: 'Balances' },
  { id: 'activity', label: 'Activity' },
]

export function DashboardPanel({
  tab,
  onTabChange,
  attention,
  positions,
  portfolioValue,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* Tabs */}
      <div className="flex h-14 shrink-0 items-center gap-0.5 border-b border-border px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTabChange(t.id)}
            className={cn(
              'rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors',
              tab === t.id
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'overview' && (
          <div className="flex flex-col gap-6 p-5">
            {/* Portfolio hero */}
            <div className="rounded-2xl border border-border/60 bg-background/50 px-5 py-5">
              <p className="text-sm text-muted-foreground">Portfolio value</p>
              <p className="mt-2 text-4xl font-bold tracking-tight tabular-nums text-foreground">
                {portfolioValue}
              </p>
            </div>

            {/* Needs attention */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Bell className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
                <h2 className="text-sm font-medium text-muted-foreground">Needs attention</h2>
                {attention.length > 0 && (
                  <span className="rounded-full bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                    {attention.length}
                  </span>
                )}
              </div>
              {attention.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                  All caught up.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {attention.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-4 py-3.5"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
                        <AgentIcon agent={a.agent} className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{a.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{a.subtitle}</p>
                      </div>
                      <span className="shrink-0 text-sm font-semibold text-primary">{a.meta}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Active positions */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Sparkles className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
                <h2 className="text-sm font-medium text-muted-foreground">Active positions</h2>
                <span className="rounded-full bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                  {positions.length}
                </span>
              </div>
              <ul className="flex flex-col gap-2">
                {positions.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-4 py-3.5"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
                      <AgentIcon agent={p.agent} className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{p.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{p.subtitle}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums text-foreground">{p.value}</p>
                      <p
                        className={cn(
                          'text-xs font-medium',
                          p.metaPositive ? 'text-primary' : 'text-muted-foreground',
                        )}
                      >
                        {p.meta}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}

        {tab === 'balances' && <LiveBalances />}

        {tab === 'activity' && <LiveActivity />}
      </div>
    </div>
  )
}
