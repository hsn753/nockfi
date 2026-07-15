'use client'

import { useEffect, useState } from 'react'
import { ShieldCheck, Percent, Zap } from 'lucide-react'
import { usePrivy, useWallets, getIdentityToken } from '@privy-io/react-auth'
import { cn } from '@/lib/utils'
import { type AttentionItem, type Position } from './data'
import { AgentIcon } from './agent-icon'
import { LiveBalances } from './live-balances'
import { LiveActivity } from './live-activity'

// The doc's "small Vault panel shows your current spend limits ... in plain view" —
// self-contained like LiveBalances, fetches the real, saved limit from
// app/api/guardrails (see lib/db/guardrails.ts), never a placeholder number.
// Live yield positions in plain view, so the user doesn't have to keep asking Robin
// "what am I holding in yield" — reads real on-chain positions (accrued interest
// included) via /api/yield-positions, refreshed every 60s and on wallet change.
function YieldPositionsCard() {
  const { ready, authenticated } = usePrivy()
  const { wallets } = useWallets()
  const address = wallets[0]?.address

  const [positions, setPositions] = useState<
    { market: string; collateralSymbol: string; suppliedUsd: number; apyPct: number | null }[] | null
  >(null)

  useEffect(() => {
    if (!ready || !authenticated || !address) {
      setPositions(null)
      return
    }
    let cancelled = false
    const load = () => {
      fetch(`/api/yield-positions?address=${encodeURIComponent(address)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data) setPositions(data.positions ?? [])
        })
        .catch(() => {})
    }
    load()
    const interval = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [ready, authenticated, address])

  if (!positions || positions.length === 0) return null

  const total = positions.reduce((sum, p) => sum + p.suppliedUsd, 0)

  return (
    <div className="rounded-3xl bg-secondary px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Percent className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
          <p className="text-sm text-muted-foreground">Yield positions</p>
        </div>
        <p className="text-sm font-semibold text-foreground">${total.toFixed(2)}</p>
      </div>
      <ul className="mt-2.5 flex flex-col gap-2">
        {positions.map((p) => (
          <li key={p.market} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{p.market} market</p>
              <p className="truncate text-xs text-muted-foreground">
                {p.apyPct !== null ? `${p.apyPct.toFixed(2)}% APY, live` : 'APY unavailable'}
              </p>
            </div>
            <p className="shrink-0 text-sm font-medium text-foreground">
              ${p.suppliedUsd.toFixed(2)}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Lent on Morpho, interest included. Withdraw any time via chat.
      </p>
    </div>
  )
}

// The instant-swap (embedded) wallet's real holdings — a separate address from the
// connected wallet, previously only visible by asking Robin or digging into Settings.
// Shown whenever the embedded wallet exists, with its delegation state.
function InstantSwapWalletCard() {
  const { ready, authenticated, user: privyUser } = usePrivy()

  const embedded = privyUser?.linkedAccounts?.find(
    (a: any) => a.type === 'wallet' && a.walletClientType === 'privy' && a.chainType === 'ethereum',
  ) as { address: string; delegated?: boolean } | undefined

  const [balances, setBalances] = useState<
    { symbol: string; amount: string; usdValue?: number | null }[] | null
  >(null)

  useEffect(() => {
    if (!ready || !authenticated || !embedded?.address) {
      setBalances(null)
      return
    }
    let cancelled = false
    const load = () => {
      fetch(`/api/balances?address=${encodeURIComponent(embedded.address)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data) setBalances(data.balances ?? [])
        })
        .catch(() => {})
    }
    load()
    const interval = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [ready, authenticated, embedded?.address])

  if (!embedded || !balances) return null

  const total = balances.reduce((sum, b) => sum + (b.usdValue ?? 0), 0)
  // Strip every non-numeric char (commas AND the "<" in the backend's "<0.0001" dust
  // formatting) before parsing — `replace(/,/g,'')` left "<0.0001" as NaN, so held dust
  // rows were silently dropped and the card fell through to its empty state.
  const held = balances.filter((b) => parseFloat(String(b.amount).replace(/[^0-9.]/g, '')) > 0)

  return (
    <div className="rounded-3xl bg-secondary px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Zap className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
          <p className="text-sm text-muted-foreground">Instant-swap wallet</p>
        </div>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', embedded.delegated ? 'bg-primary' : 'bg-muted-foreground')} />
          {embedded.delegated ? 'Enabled' : 'Disabled'}
        </span>
      </div>
      <p className="mt-1.5 text-lg font-semibold text-foreground">${total.toFixed(2)}</p>
      {held.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-1">
          {held.map((b) => (
            <li key={b.symbol} className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{b.symbol}</span>
              <span>
                {b.amount}
                {b.usdValue != null ? ` ($${b.usdValue.toFixed(2)})` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-0.5 text-xs text-muted-foreground">Empty. Send funds to it from Settings to use instant swaps.</p>
      )}
    </div>
  )
}

function GuardrailsCard() {
  const { ready, authenticated } = usePrivy()
  const { wallets } = useWallets()
  const address = wallets[0]?.address

  const [limit, setLimit] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    if (!ready || !authenticated || !address) {
      setLimit(undefined)
      return
    }
    let cancelled = false
    ;(async () => {
      const identityToken = await getIdentityToken()
      const res = await fetch(`/api/guardrails?walletAddress=${address}`, {
        headers: { 'X-Privy-Identity-Token': identityToken ?? '' },
      }).catch(() => null)
      const data = res && res.ok ? await res.json() : null
      if (!cancelled) setLimit(data?.maxUsdPerTransaction ?? null)
    })()
    return () => {
      cancelled = true
    }
  }, [ready, authenticated, address])

  if (limit === undefined) return null

  return (
    <div className="rounded-3xl bg-secondary px-5 py-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
        <p className="text-sm text-muted-foreground">Vault guardrails</p>
      </div>
      <p className="mt-1.5 text-lg font-semibold text-foreground">
        {limit !== null ? `$${limit} per transaction` : 'No spend limit set'}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Enforced before any swap or yield deposit is proposed. Adjust it in Settings.
      </p>
    </div>
  )
}

type DashTab = 'overview' | 'balances' | 'activity'

type Props = {
  tab: DashTab
  onTabChange: (t: DashTab) => void
  attention: AttentionItem[]
  positions: Position[]
  portfolioValue: string
  // Real week-over-week change from daily snapshots; null = not enough history
  // yet, and the line is simply not rendered (never a fabricated percentage).
  weeklyChangePct: number | null
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
  weeklyChangePct,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* Tabs — lime pill for the active tab, per the Figma rail */}
      <div className="flex h-14 shrink-0 items-center gap-1 px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTabChange(t.id)}
            className={cn(
              'rounded-full px-3.5 py-1.5 font-serif text-sm transition-colors',
              tab === t.id
                ? 'bg-primary text-primary-foreground'
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
            {/* Portfolio hero — black card with the arrow-nock photo bleeding off the
                right, per the Figma. Card bg is #02050a (matches the photo's own black
                background) so the image blends seamlessly with no seam. */}
            <div className="relative overflow-hidden rounded-3xl bg-background px-5 py-6">
              <img
                src="/brand/arrow-nock.jpg"
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute -right-2 top-1/2 h-[130%] w-40 -translate-y-1/2 object-contain object-right"
              />
              <div className="pointer-events-none absolute inset-y-0 left-0 w-2/3 bg-gradient-to-r from-background via-background/90 to-transparent" />
              <div className="relative">
                <p className="text-sm text-muted-foreground">Portfolio Value</p>
                <p className="mt-2 font-serif text-4xl tracking-tight text-foreground">
                  {portfolioValue}
                </p>
                {weeklyChangePct !== null && (
                  <p className={cn('mt-2 text-sm font-medium', weeklyChangePct >= 0 ? 'text-primary' : 'text-red-400')}>
                    {weeklyChangePct >= 0 ? '+' : ''}
                    {weeklyChangePct.toFixed(1)}% this week
                  </p>
                )}
              </div>
            </div>

            {/* Yield positions */}
            <YieldPositionsCard />

            {/* Instant-swap wallet */}
            <InstantSwapWalletCard />

            {/* Guardrails */}
            <GuardrailsCard />

            {/* Needs attention */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <h2 className="font-serif text-lg text-foreground">Needs Attention</h2>
                {attention.length > 0 && (
                  <span className="rounded-full bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                    {attention.length}
                  </span>
                )}
              </div>
              {attention.length === 0 ? (
                <p className="rounded-2xl bg-secondary px-4 py-8 text-center text-sm text-muted-foreground">
                  All caught up.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {attention.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center gap-3 rounded-2xl bg-secondary px-4 py-3.5"
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
                <h2 className="font-serif text-lg text-foreground">Active Positions</h2>
                <span className="rounded-full bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                  {positions.length}
                </span>
              </div>
              <ul className="flex flex-col gap-2">
                {positions.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-3 rounded-2xl bg-secondary px-4 py-3.5"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
                      <AgentIcon agent={p.agent} className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{p.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{p.subtitle}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold text-foreground">{p.value}</p>
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
