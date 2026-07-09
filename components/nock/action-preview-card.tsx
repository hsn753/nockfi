'use client'

import { Check, Loader2, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getAgent, type ActionPreview } from './data'
import { AgentIcon } from './agent-icon'

type Props = {
  action: ActionPreview
  onDraw: (id: string) => void
  onLoose: (id: string) => void
}

export function ActionPreviewCard({ action, onDraw, onLoose }: Props) {
  const agent = getAgent(action.agent)
  const executed = action.status === 'executed'
  const confirming = action.status === 'confirming'
  const reviewing = action.status === 'reviewing'

  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-border/70 bg-card">
      {/* Agent chip */}
      <div className="flex items-center gap-2 px-5 pt-5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
          <AgentIcon agent={action.agent} className="size-3.5" />
        </span>
        <span className="text-xs font-medium text-muted-foreground">{agent.name}</span>
        {executed && (
          <span className="ml-auto flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            Active
          </span>
        )}
      </div>

      {/* Action body */}
      <div className="px-5 pb-5 pt-3">
        <p className="text-[15px] font-semibold leading-snug text-foreground">
          {action.action}
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {action.detail}
        </p>

        {/* Metrics */}
        <div className="mt-5 grid grid-cols-3 gap-2.5">
          {action.metrics.map((m) => (
            <div
              key={m.label}
              className="flex flex-col gap-1 rounded-xl bg-secondary/60 px-3 py-3.5"
            >
              <span className="text-[11px] leading-none text-muted-foreground">
                {m.label}
              </span>
              <span
                className={cn(
                  'text-lg font-bold tabular-nums leading-none',
                  m.positive ? 'text-primary' : 'text-foreground',
                )}
              >
                {m.value}
              </span>
            </div>
          ))}
        </div>

        {/* Safety disclosure */}
        {reviewing && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-border bg-background/40 px-4 py-3 text-sm text-muted-foreground">
            <ShieldCheck
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              strokeWidth={1.75}
            />
            <p className="leading-relaxed">
              Reviewed. Funds stay in your wallet until you loose the action.
              You can withdraw at any time with no lockup.
            </p>
          </div>
        )}

        {/* Buttons / status */}
        {executed ? (
          <div className="mt-4 flex items-center gap-2 text-sm font-medium text-primary">
            <Check className="size-4" strokeWidth={2.5} />
            Loosed. Moved to active positions.
          </div>
        ) : (
          <div className="mt-4 flex gap-2.5">
            <button
              type="button"
              disabled={confirming}
              onClick={() => onDraw(action.id)}
              className="flex-1 rounded-xl border border-border bg-secondary/60 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
            >
              Draw
            </button>
            <button
              type="button"
              disabled={confirming}
              onClick={() => onLoose(action.id)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-70"
            >
              {confirming ? (
                <>
                  <Loader2 className="size-4 animate-spin" strokeWidth={2} />
                  Loosing
                </>
              ) : (
                'Loose'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
