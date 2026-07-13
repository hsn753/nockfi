'use client'

import { MessageSquare, LayoutDashboard, Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NavView } from './data'
import { NockMark } from './nock-logo'

type Props = {
  active: NavView
  onChange: (v: NavView) => void
}

// Figma's mobile nav shows Chat / Agents / Settings with the N-mark for Agents;
// Dashboard stays as a fourth tab because Balances/Activity/portfolio have no
// other route on mobile — dropping it would strand real functionality.
const tabs: { view: NavView; label: string; icon: 'mark' | typeof MessageSquare }[] = [
  { view: 'chat', label: 'Chat', icon: MessageSquare },
  { view: 'agents', label: 'Agents', icon: 'mark' },
  { view: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { view: 'settings', label: 'Settings', icon: Settings },
]

export function BottomNav({ active, onChange }: Props) {
  // Overview maps visually to the dashboard tab on mobile.
  const normalized: NavView = active === 'overview' ? 'dashboard' : active
  return (
    <nav className="flex shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      {tabs.map((t) => {
        const isActive = normalized === t.view
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
            {t.icon === 'mark' ? (
              <NockMark className="size-5" monochrome={!isActive} />
            ) : (
              <t.icon className="size-5" strokeWidth={1.75} />
            )}
            {t.label}
          </button>
        )
      })}
    </nav>
  )
}
