'use client'

import { Lock, ChevronLeft, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agents, getAgent, type AgentId } from './data'
import { AgentIcon } from './agent-icon'

type Props = {
  selectedAgent: AgentId | null
  onSelect: (id: AgentId | null) => void
  onChatWithRobin: () => void
}

export function AgentsView({ selectedAgent, onSelect, onChatWithRobin }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background md:flex-row md:gap-3 md:bg-transparent">
      {/* Grid */}
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto md:rounded-2xl md:border md:border-border md:bg-card',
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
                  <span
                    className={cn(
                      'text-xs',
                      a.status === 'active' ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {a.status === 'active' ? 'Active' : 'Available'}
                  </span>
                </div>
                {a.gated && (
                  <span className="flex items-center gap-1 rounded-full border border-primary/50 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
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
        <AgentDetail id={selectedAgent} onBack={() => onSelect(null)} onChatWithRobin={onChatWithRobin} />
      )}
    </div>
  )
}

function AgentDetail({ id, onBack, onChatWithRobin }: { id: AgentId; onBack: () => void; onChatWithRobin: () => void }) {
  const agent = getAgent(id)
  return (
    <div className="flex min-h-0 w-full flex-col overflow-y-auto bg-card md:w-96 md:shrink-0 md:rounded-2xl md:border md:border-border">
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
            <h2 className="font-serif text-lg text-foreground">
              {agent.name}
            </h2>
            <span
              className={cn(
                'text-xs',
                agent.status === 'active' ? 'text-primary' : 'text-muted-foreground',
              )}
            >
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

        <h3 className="mt-6 font-serif text-lg text-foreground">
          What It Does
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
          onClick={onChatWithRobin}
          className="mt-6 w-full rounded-full bg-primary px-4 py-3.5 font-serif text-base text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Chat With Robin
        </button>
        {agent.gated && (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Actions unlock with $NOCK at token launch — asking questions is always free.
          </p>
        )}
      </div>
    </div>
  )
}
