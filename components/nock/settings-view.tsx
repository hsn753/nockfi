'use client'

import { useState } from 'react'
import { usePrivy, useWallets, useCreateWallet, useDelegatedActions } from '@privy-io/react-auth'
import { Loader2 } from 'lucide-react'
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

          {ready && authenticated && <InstantSwapsSection />}

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

function InstantSwapsSection() {
  const { user: privyUser } = usePrivy()
  const { createWallet } = useCreateWallet()
  const { delegateWallet, revokeWallets } = useDelegatedActions()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const embeddedWallet = privyUser?.linkedAccounts?.find(
    (a): a is Extract<typeof a, { type: 'wallet' }> =>
      a.type === 'wallet' && (a as any).walletClientType === 'privy' && (a as any).chainType === 'ethereum',
  ) as { address: string; delegated: boolean } | undefined

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-border bg-card p-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Instant swaps
      </h2>
      <p className="mt-1.5 text-xs text-muted-foreground text-pretty">
        Skip the per-transaction mobile approval by creating a separate Nock wallet and
        granting Robin permission to swap on your behalf, within a spend limit you control.
        This is a different address from your connected wallet — you'll need to bridge or
        send funds to it separately.
      </p>

      {!embeddedWallet ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => createWallet())}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 disabled:opacity-50"
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          Create instant-swap wallet
        </button>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-4 rounded-lg border border-border bg-background/40 px-3 py-2.5">
          <div>
            <p className="text-xs text-muted-foreground">Instant-swap wallet</p>
            <p className="font-mono text-sm text-foreground">{embeddedWallet.address}</p>
          </div>
          {embeddedWallet.delegated ? (
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="size-1.5 rounded-full bg-primary" />
                Enabled
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => run(revokeWallets)}
                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Disable
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => delegateWallet({ address: embeddedWallet.address, chainType: 'ethereum' }))}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {busy && <Loader2 className="size-3 animate-spin" />}
              Enable
            </button>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}
