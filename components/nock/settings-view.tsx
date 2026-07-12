'use client'

import { useEffect, useState } from 'react'
import { usePrivy, useWallets, useCreateWallet, useSigners, useExportWallet, getIdentityToken } from '@privy-io/react-auth'
import type { DelegatedWalletEventType } from '@/lib/log-delegated-event'
import { logDelegatedWalletEventClient } from '@/lib/log-delegated-event'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { user } from './data'

// There's no wallet extension UI for the embedded instant-swap wallet the way there is
// for a connected MetaMask/Phantom, so without this it's genuinely invisible — the only
// way to check its balance was asking Robin for its address by name every time.
function useEmbeddedBalance(address: string | undefined) {
  const [totalUsd, setTotalUsd] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!address) {
      setTotalUsd(null)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/balances?address=${address}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        const total = (data.balances || []).reduce(
          (sum: number, b: { usdValue?: number | null }) => sum + (b.usdValue ?? 0),
          0,
        )
        setTotalUsd(total)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [address])

  return { totalUsd, loading }
}

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

          {ready && authenticated && <GuardrailsSection />}

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

// Key quorum + policy registered in the Privy Dashboard (Wallet infrastructure ->
// Keys and quorums / Policies) for Nock's server-side signer. Not secret — only the
// authorization private key backing this quorum (PRIVY_AUTHORIZATION_PRIVATE_KEY,
// server-side only) needs to stay confidential.
const SESSION_SIGNER_ID = 'cv6ka6rbhmabtaydbh9e6pbo'
const SESSION_POLICY_ID = 'mw6vn6xz49aehqip0ia7ezl4'

// This is the real, user-configurable half of Vault Agent's spend limit — an
// additional, app-level ceiling checked in propose_action (app/api/robin/route.ts)
// before any swap/yield action is ever proposed, on top of (not instead of) the
// hardcoded global Privy policy above.
function GuardrailsSection() {
  const { wallets } = useWallets()
  const walletAddress = wallets[0]?.address

  const [limit, setLimit] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!walletAddress) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const identityToken = await getIdentityToken()
      const res = await fetch(`/api/guardrails?walletAddress=${walletAddress}`, {
        headers: { 'X-Privy-Identity-Token': identityToken ?? '' },
      }).catch(() => null)
      const data = res && res.ok ? await res.json() : null
      if (cancelled) return
      setLimit(data?.maxUsdPerTransaction ?? null)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [walletAddress])

  const save = async () => {
    if (!walletAddress) return
    const value = parseFloat(input)
    if (isNaN(value) || value <= 0) {
      setError('Enter a positive dollar amount.')
      return
    }
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const identityToken = await getIdentityToken()
      const res = await fetch('/api/guardrails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Privy-Identity-Token': identityToken ?? '' },
        body: JSON.stringify({ walletAddress, maxUsdPerTransaction: value }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not save this limit')
      setLimit(value)
      setInput('')
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-border bg-card p-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Guardrails
      </h2>
      <p className="mt-1.5 text-xs text-muted-foreground text-pretty">
        Vault agent enforces this limit on every swap or yield deposit Robin proposes —
        before you ever see a preview, not just at execution. Applies to both instant
        swaps and your connected wallet.
      </p>

      <div className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
        <p className="text-xs text-muted-foreground">Current spend limit</p>
        <p className="text-sm text-foreground">
          {loading ? 'Loading...' : limit !== null ? `$${limit} per transaction` : 'No limit set'}
        </p>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <input
          type="number"
          min="0"
          step="1"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. 500"
          className="min-w-0 flex-1 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <button
          type="button"
          disabled={saving || !input}
          onClick={save}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {saving && <Loader2 className="size-3 animate-spin" />}
          Save limit
        </button>
      </div>

      {saved && <p className="mt-2 text-xs text-primary">Limit saved.</p>}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}

function InstantSwapsSection() {
  const { user: privyUser } = usePrivy()
  const { wallets } = useWallets()
  const { createWallet } = useCreateWallet()
  const { addSigners, removeSigners } = useSigners()
  const { exportWallet } = useExportWallet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const ownerWalletAddress = wallets[0]?.address

  const embeddedWallet = privyUser?.linkedAccounts?.find(
    (a): a is Extract<typeof a, { type: 'wallet' }> =>
      a.type === 'wallet' && (a as any).walletClientType === 'privy' && (a as any).chainType === 'ethereum',
  ) as { address: string; delegated: boolean; id?: string } | undefined

  // identityToken fetched fresh here (not from the reactive useIdentityToken() hook,
  // confirmed live to not reliably reflect a usable token for an already-connected
  // session) rather than cached.
  const logEvent = async (eventType: DelegatedWalletEventType) => {
    if (!ownerWalletAddress || !embeddedWallet?.id) return
    const identityToken = await getIdentityToken()
    logDelegatedWalletEventClient({
      ownerWalletAddress,
      embeddedAddress: embeddedWallet.address,
      privyWalletId: embeddedWallet.id,
      signerId: SESSION_SIGNER_ID,
      policyId: SESSION_POLICY_ID,
      eventType,
      identityToken,
    })
  }

  const { totalUsd: embeddedBalanceUsd, loading: balanceLoading } = useEmbeddedBalance(embeddedWallet?.address)

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
        granting Robin permission to swap on your behalf, within the spend limit set below.
        This is a different address from your connected wallet — you'll need to bridge or
        send funds to it separately.
      </p>

      {!embeddedWallet ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const wallet = await createWallet()
              if (ownerWalletAddress && wallet.id) {
                logDelegatedWalletEventClient({
                  ownerWalletAddress,
                  embeddedAddress: wallet.address,
                  privyWalletId: wallet.id,
                  signerId: SESSION_SIGNER_ID,
                  policyId: SESSION_POLICY_ID,
                  eventType: 'created',
                  identityToken: await getIdentityToken(),
                })
              }
            })
          }
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 disabled:opacity-50"
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          Create instant-swap wallet
        </button>
      ) : (
        <div className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Instant-swap wallet</p>
              <p className="font-mono text-sm text-foreground">{embeddedWallet.address}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {balanceLoading
                  ? 'Loading balance...'
                  : embeddedBalanceUsd !== null
                    ? `$${embeddedBalanceUsd.toFixed(2)} on Robinhood Chain`
                    : 'Balance unavailable'}
              </p>
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
                  onClick={() =>
                    run(async () => {
                      await removeSigners({ address: embeddedWallet.address })
                      await logEvent('disabled')
                    })
                  }
                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  Disable
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await addSigners({
                      address: embeddedWallet.address,
                      signers: [{ signerId: SESSION_SIGNER_ID, policyIds: [SESSION_POLICY_ID] }],
                    })
                    await logEvent('enabled')
                  })
                }
                className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {busy && <Loader2 className="size-3 animate-spin" />}
                Enable
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() =>
              run(async () => {
                await exportWallet({ address: embeddedWallet.address })
                await logEvent('export_initiated')
              })
            }
            className="mt-2.5 flex w-full items-center justify-center rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          >
            Export private key
          </button>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Opens a Privy-hosted screen to reveal this wallet's key so you can move funds
            out yourself (e.g. import into MetaMask). Nock never sees or stores it.
          </p>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}
