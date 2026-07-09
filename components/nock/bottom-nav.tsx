'use client'

import { MessageSquare, LayoutDashboard, Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NavView } from './data'

type Props = {
  active: NavView
  onChange: (v: NavView) => void
}

const tabs: { view: NavView; label: string; icon: typeof Bot }[] = [
  { view: 'chat', label: 'Chat', icon: MessageSquare },
  { view: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { view: 'agents', label: 'Agents', icon: Bot },
]

export function BottomNav({ active, onChange }: Props) {
  // Overview maps visually to the dashboard tab on mobile.
  const normalized: NavView = active === 'overview' ? 'dashboard' : active
  return (
    <nav className="flex shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      {tabs.map((t) => {
        const isActive = normalized === t.view
        const Icon = t.icon
        return (
          <button
            key={t.view}
            type="button"
            onClick={() => onChange(t.view)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex flex-1 flex-col items-center gap-1 py-2.5 text-xs transition-colors',
              isActive ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <Icon className="size-5" strokeWidth={1.75} />
            {t.label}
          </button>
        )
      })}
    </nav>
  )
}
