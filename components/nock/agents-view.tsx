'use client'

import { Lock, ChevronLeft, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agents, getAgent, type AgentId } from './data'
import { AgentIcon } from './agent-icon'

type Props = {
  selectedAgent: AgentId | null
  onSelect: (id: AgentId | null) => void
}

export function AgentsView({ selectedAgent, onSelect }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background md:flex-row">
      {/* Grid */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          selectedAgent && 'hidden md:block',
        )}
      >
        <header className="flex items-center border-b border-border px-5 py-4">
          <div>
            <h1 className="font-serif text-2xl text-foreground">Nock Agent Suite</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              All of our tailored agents in one spot.
            </p>
          </div>
        </header>
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelect(a.id)}
              className={cn(
                'group flex flex-col rounded-xl border bg-card p-4 text-left transition-colors hover:bg-secondary/50',
                selectedAgent === a.id
                  ? 'border-foreground/20'
                  : 'border-border',
              )}
            >
              <div className="flex items-center gap-2.5">
                <span className="flex size-9 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
                  <AgentIcon agent={a.id} className="size-4.5" />
                </span>
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {a.name}
                  </p>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        a.status === 'active' ? 'bg-primary' : 'bg-muted-foreground/40',
                      )}
                    />
                    {a.status === 'active' ? 'Active' : 'Available'}
                  </span>
                </div>
                {a.gated && (
                  <span className="flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    <Lock className="size-3" strokeWidth={2} />
                    $NOCK
                  </span>
                )}
              </div>
              <p className="mt-3 text-sm text-muted-foreground text-pretty">
                {a.tagline}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Detail panel */}
      {selectedAgent && (
        <AgentDetail id={selectedAgent} onBack={() => onSelect(null)} />
      )}
    </div>
  )
}

function AgentDetail({ id, onBack }: { id: AgentId; onBack: () => void }) {
  const agent = getAgent(id)
  return (
    <div className="flex min-h-0 w-full flex-col overflow-y-auto bg-card md:w-96 md:shrink-0 md:border-l md:border-border">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" strokeWidth={1.75} />
          Back
        </button>
      </div>

      <div className="p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
            <AgentIcon agent={agent.id} className="size-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {agent.name}
            </h2>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  agent.status === 'active' ? 'bg-primary' : 'bg-muted-foreground/40',
                )}
              />
              {agent.status === 'active' ? 'Active' : 'Available'}
            </span>
          </div>
        </div>

        {agent.gated && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-secondary/60 px-3 py-2.5 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
            <p className="text-pretty">
              Requires $NOCK. Hold $NOCK to unlock this agent and its actions.
            </p>
          </div>
        )}

        <p className="mt-4 text-sm text-muted-foreground text-pretty leading-relaxed">
          {agent.description}
        </p>

        <h3 className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          What it does
        </h3>
        <ul className="mt-2 flex flex-col gap-2">
          {agent.capabilities.map((c) => (
            <li key={c} className="flex items-start gap-2 text-sm text-foreground">
              <Check
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                strokeWidth={2}
              />
              <span className="text-pretty">{c}</span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          className={cn(
            'mt-6 w-full rounded-xl px-3 py-3 text-sm font-semibold transition-colors',
            agent.gated
              ? 'border border-border bg-secondary text-foreground hover:bg-secondary/70'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
        >
          {agent.gated ? 'Unlock with $NOCK' : 'Chat with Robin about this'}
        </button>
      </div>
    </div>
  )
}
