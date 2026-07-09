'use client'

import { useState } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { cn } from '@/lib/utils'
import { user } from './data'

function Toggle({
  label,
  desc,
  defaultOn,
}: {
  label: string
  desc: string
  defaultOn?: boolean
}) {
  const [on, setOn] = useState(!!defaultOn)
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-3.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground text-pretty">{desc}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => setOn((v) => !v)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors',
          on ? 'bg-primary' : 'bg-secondary',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-4 rounded-full bg-background transition-transform',
            on ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  )
}

export function SettingsView() {
  const { ready, authenticated, login, logout } = usePrivy()
  const { wallets } = useWallets()

  const connectedAddress = wallets[0]?.address

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-5">
        <div>
          <h1 className="text-sm font-semibold text-foreground">Settings</h1>
          <p className="text-xs text-muted-foreground">
            Manage your wallet and agent preferences
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-5 md:px-5">
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Wallet
            </h2>
            {ready && authenticated && connectedAddress ? (
              <div className="mt-3 flex items-center justify-between gap-4 rounded-lg border border-border bg-background/40 px-3 py-2.5">
                <div>
                  <p className="text-xs text-muted-foreground">Connected wallet</p>
                  <p className="font-mono text-sm text-foreground">
                    {connectedAddress}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-primary" />
                    Connected
                  </span>
                  <button
                    type="button"
                    onClick={logout}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={login}
                disabled={!ready}
                className="mt-3 flex w-full items-center justify-center rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 disabled:opacity-50"
              >
                Connect wallet
              </button>
            )}
          </section>

          <section className="mt-4 rounded-xl border border-border bg-card p-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Agent preferences
            </h2>
            <div className="mt-1">
              <Toggle
                label="Auto-loose safe actions"
                desc="Let Robin execute low-risk actions without confirmation"
              />
              <Toggle
                label="Rebalance alerts"
                desc="Notify me when a vault drifts from its target"
                defaultOn
              />
              <Toggle
                label="Better rate alerts"
                desc="Notify me when the yield agent finds a higher rate"
                defaultOn
              />
            </div>
          </section>

          <section className="mt-4 rounded-xl border border-border bg-card p-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Season 1
            </h2>
            <div className="mt-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-foreground">
                  <span className="text-primary">{user.draws}</span> draws
                  earned
                </span>
                <span className="text-muted-foreground">
                  {user.seasonProgress}%
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${user.seasonProgress}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground text-pretty">
                Earn draws by letting your agents work. Draws convert to rewards
                at the end of the season.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
