'use client'

import { useState } from 'react'
import {
  LayoutGrid,
  MessageSquare,
  Activity,
  Settings,
  ChevronDown,
  Wallet,
  X,
} from 'lucide-react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { cn } from '@/lib/utils'
import type { ConversationSummary } from '@/lib/chat-storage'
import { agents, user, type NavView, type AgentId } from './data'
import { AgentIcon } from './agent-icon'
import { NockLogo, NockMark } from './nock-logo'

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  if (hours < 48) return 'Yesterday'
  return `${Math.floor(hours / 24)}d ago`
}

type Props = {
  activeView: NavView
  onNavigate: (view: NavView) => void
  onSelectAgent: (id: AgentId) => void
  selectedAgent: AgentId | null
  history: ConversationSummary[]
  activeConversationId: string | null
  onLoadConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
}

const navItems: { view: NavView; label: string; icon: typeof LayoutGrid }[] = [
  { view: 'overview', label: 'Overview', icon: LayoutGrid },
  { view: 'chat', label: 'Chat with Robin', icon: MessageSquare },
]

export function Sidebar({
  activeView,
  onNavigate,
  onSelectAgent,
  selectedAgent,
  history,
  activeConversationId,
  onLoadConversation,
  onDeleteConversation,
}: Props) {
  const [agentsOpen, setAgentsOpen] = useState(true)
  const { ready, authenticated, login } = usePrivy()
  const { wallets } = useWallets()

  const connectedAddress = wallets[0]?.address
  const shortAddress = connectedAddress
    ? `${connectedAddress.slice(0, 6)}...${connectedAddress.slice(-4)}`
    : null

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Wordmark */}
      <div className="flex h-14 items-center px-5">
        <NockLogo />
      </div>

      {/* Nav */}
      <nav className="shrink-0 px-3 py-2">
        <ul className="flex flex-col gap-0.5">
          {navItems.map((item) => (
            <li key={item.view}>
              <NavButton
                icon={item.icon}
                label={item.label}
                active={activeView === item.view}
                onClick={() => onNavigate(item.view)}
              />
            </li>
          ))}

          {/* Agents expandable */}
          <li>
            <div
              className={cn(
                'group flex w-full items-center rounded-lg text-sm transition-colors',
                activeView === 'agents' && !selectedAgent
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              )}
            >
              <button
                type="button"
                onClick={() => {
                  setAgentsOpen(true)
                  onNavigate('agents')
                }}
                className="flex flex-1 items-center gap-3 py-2.5 pl-3 pr-2 text-left"
              >
                <NockMark className="size-4 shrink-0" />
                <span className="flex-1">Agents</span>
              </button>
              <button
                type="button"
                onClick={() => setAgentsOpen((v) => !v)}
                aria-label={agentsOpen ? 'Collapse agents' : 'Expand agents'}
                className="flex items-center py-2.5 pl-1 pr-3"
              >
                <ChevronDown
                  className={cn(
                    'size-4 shrink-0 transition-transform',
                    agentsOpen ? 'rotate-0' : '-rotate-90',
                  )}
                  strokeWidth={1.75}
                />
              </button>
            </div>
            {agentsOpen && (
              <ul className="mt-0.5 flex flex-col gap-0.5 pl-4">
                {agents.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => onSelectAgent(a.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg py-2 pl-3 pr-2 text-sm transition-colors',
                        activeView === 'agents' && selectedAgent === a.id
                          ? 'bg-secondary text-foreground'
                          : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                      )}
                    >
                      <AgentIcon agent={a.id} className="size-4 shrink-0" />
                      <span className="flex-1 text-left">
                        {a.name.replace(' agent', '')}
                      </span>
                      {a.gated && (
                        <span className="size-1.5 rounded-full bg-primary/70" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>

          <li>
            <NavButton
              icon={Activity}
              label="Activity"
              active={activeView === 'activity'}
              onClick={() => onNavigate('activity')}
            />
          </li>
          <li>
            <NavButton
              icon={Settings}
              label="Settings"
              active={activeView === 'settings'}
              onClick={() => onNavigate('settings')}
            />
          </li>
        </ul>
      </nav>

      {/* Chat history */}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-3 py-3">
        <p className="mb-1.5 px-3 text-xs font-medium text-muted-foreground">Chats</p>
        {history.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No conversations yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {history.map((conv) => (
              <li key={conv.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onLoadConversation(conv.id)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
                    activeConversationId === conv.id
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{conv.title}</span>
                  <span className="shrink-0 text-xs opacity-50">
                    {formatRelative(conv.createdAt)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteConversation(conv.id)}
                  aria-label="Delete conversation"
                  className="hidden size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground group-hover:flex"
                >
                  <X className="size-3.5" strokeWidth={1.75} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Wallet chip + season */}
      <div className="border-t border-border p-3">
        {ready && authenticated && shortAddress ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-background/40 px-3 py-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <Wallet className="size-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs text-foreground">
                {shortAddress}
              </p>
              <p className="text-xs text-muted-foreground">
                <span className="text-primary">{user.draws}</span> draws · Season 1 not started
              </p>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={login}
            disabled={!ready}
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-background/40 px-3 py-3 transition-colors hover:bg-secondary/60 disabled:opacity-50"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <Wallet className="size-4" strokeWidth={1.75} />
            </span>
            <span className="text-sm text-muted-foreground">Connect wallet</span>
          </button>
        )}

        {ready && authenticated && (
          <div className="mt-3 px-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{user.season} · starts at $NOCK launch</span>
              <span className="text-muted-foreground">{user.seasonProgress}%</span>
            </div>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${user.seasonProgress}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function NavButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof LayoutGrid
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors',
        active
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
      )}
      aria-current={active ? 'page' : undefined}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="flex-1 text-left">{label}</span>
    </button>
  )
}
