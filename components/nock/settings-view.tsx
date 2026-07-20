'use client'

import { useEffect, useState } from 'react'
import { usePrivy, useWallets, useCreateWallet, useSigners, useExportWallet, getIdentityToken } from '@privy-io/react-auth'
import { usePublicClient } from 'wagmi'
import { createWalletClient, custom } from 'viem'
import type { DelegatedWalletEventType } from '@/lib/log-delegated-event'
import { logDelegatedWalletEventClient } from '@/lib/log-delegated-event'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { INSTANT_SWAPS_ENABLED, PERPS_KEY_ONBOARDING_ENABLED } from '@/lib/feature-flags'
import { nockChain } from '@/lib/chain'
import { lookupLighterAccount, listLighterApiKeys, pickFreeApiKeyIndex, getLighterNextNonce, submitLighterTx, LIGHTER_BASE, LIGHTER_CHAIN_ID } from '@/lib/lighter-account'
import { loadStoredKeyMeta, clearStoredKey, wrapAndStore, buildWrapMessage } from '@/lib/lighter-key-storage'
import { loadLighterSigner, generateApiKey, createLighterClient, signChangePubKey } from '@/lib/lighter-wasm-client'
import { executeLighterDeposit } from '@/lib/lighter-deposit'
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
  disabled,
}: {
  label: string
  desc: string
  defaultOn?: boolean
  disabled?: boolean
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
        disabled={disabled}
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

          {/* Instant Swaps is hidden until the next version (see lib/feature-flags.ts) —
              not part of the current public spec. Component kept, just not rendered. */}
          {INSTANT_SWAPS_ENABLED && ready && authenticated && <InstantSwapsSection />}

          {/* Per-user Lighter key onboarding — hidden until Phase 2 is reviewed (see
              lib/feature-flags.ts). */}
          {PERPS_KEY_ONBOARDING_ENABLED && ready && authenticated && <PerpsKeySection />}

          <section className="mt-4 rounded-xl border border-border bg-card p-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Agent preferences
            </h2>
            <p className="mt-1.5 text-xs text-muted-foreground text-pretty">
              Coming soon. These preferences aren't active yet. Every action currently
              requires your explicit Confirm, which is the safest default.
            </p>
            <div className="mt-1 opacity-50">
              <Toggle
                label="Auto-confirm safe actions"
                desc="Let Robin execute low-risk actions without confirmation"
                disabled
              />
              <Toggle
                label="Rebalance alerts"
                desc="Notify me when a vault drifts from its target"
                disabled
              />
              <Toggle
                label="Better rate alerts"
                desc="Notify me when the yield agent finds a higher rate"
                disabled
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
                Season 1 begins when $NOCK launches, and draws will accrue from your
                real agent activity and convert to rewards at season end. Nothing
                accrues yet.
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
        Vault agent enforces this limit on every swap or yield deposit Robin proposes,
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
  // known to not reliably reflect a usable token for an already-connected
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
        This is a different address from your connected wallet, so you'll need to bridge or
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

type PerpsKeyStatus =
  | { kind: 'checking' }
  | { kind: 'restricted'; label: string }
  | { kind: 'no-account' }
  | { kind: 'depositing'; step: string }
  | { kind: 'ready' }
  | { kind: 'connecting'; step: string }
  | { kind: 'connected'; accountIndex: number; apiKeyIndex: number; publicKey: string }

// Non-custodial per-user Lighter trading key — see lib/lighter-wasm-client.ts,
// lib/lighter-key-storage.ts, lib/lighter-account.ts. Generates and registers a Lighter
// API keypair entirely client-side; Nock's servers never see the private key. For a
// wallet with no Lighter account yet, the 'no-account' state first runs a USDG deposit
// (lib/lighter-deposit.ts) — which creates the account — then chains into key setup.
function PerpsKeySection() {
  const { wallets } = useWallets()
  const publicClient = usePublicClient()
  const activeWallet = wallets[0]
  const walletAddress = activeWallet?.address

  const [status, setStatus] = useState<PerpsKeyStatus>({ kind: 'checking' })
  const [depositAmount, setDepositAmount] = useState('')
  const [addAmount, setAddAmount] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addDone, setAddDone] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!walletAddress) return
    let cancelled = false
    setStatus({ kind: 'checking' })
    setError('')
    ;(async () => {
      // Jurisdiction gate FIRST — a restricted-region user must not reach the deposit or
      // key-setup flow at all. Depositing isn't geoblocked on-chain, but registration and
      // trading are, so onboarding here would strand their funds in a Lighter account they
      // can't use. Fail-closed: if the check errors, treat as restricted.
      let eligible = false
      let label = 'your region'
      try {
        const res = await fetch('/api/perps/eligibility')
        if (res.ok) {
          const geo = (await res.json()) as { allowed?: boolean; restrictedLabel?: string }
          eligible = !!geo.allowed
          if (geo.restrictedLabel) label = geo.restrictedLabel
        }
      } catch {
        /* fail closed */
      }
      if (cancelled) return
      if (!eligible) {
        setStatus({ kind: 'restricted', label })
        return
      }

      const account = await lookupLighterAccount(walletAddress)
      if (cancelled) return
      if (!account) {
        setStatus({ kind: 'no-account' })
        return
      }
      // Trust the locally-stored key if present. We deliberately do NOT re-verify it
      // against Lighter's /apikeys on load: a freshly-registered key isn't reflected there
      // until the next rollup batch commits (~1 min, same lag as deposits), so verifying
      // would wrongly delete a valid key on a quick refresh. If a stored key is ever truly
      // invalid, the trade fails with a clear error and the user can hit Reset.
      const meta = loadStoredKeyMeta(walletAddress)
      setStatus(meta ? { kind: 'connected', ...meta } : { kind: 'ready' })
    })()
    return () => {
      cancelled = true
    }
  }, [walletAddress])

  const setup = async () => {
    if (!walletAddress || !activeWallet || status.kind !== 'ready') return
    setError('')
    try {
      const accountLookup = await lookupLighterAccount(walletAddress)
      if (!accountLookup) throw new Error('No Lighter account found for this wallet.')
      const { accountIndex } = accountLookup

      setStatus({ kind: 'connecting', step: 'Loading signer…' })
      await loadLighterSigner()

      setStatus({ kind: 'connecting', step: 'Generating your trading key…' })
      const { privateKey, publicKey } = generateApiKey()

      const existingKeys = await listLighterApiKeys(accountIndex)
      const apiKeyIndex = pickFreeApiKeyIndex(existingKeys)
      const nonce = await getLighterNextNonce(accountIndex, apiKeyIndex)

      createLighterClient(LIGHTER_BASE, privateKey, LIGHTER_CHAIN_ID, apiKeyIndex, accountIndex)
      const signed = signChangePubKey(publicKey, nonce, apiKeyIndex, accountIndex)

      const provider = await activeWallet.getEthereumProvider()
      const walletClient = createWalletClient({
        account: walletAddress as `0x${string}`,
        chain: nockChain,
        transport: custom(provider),
      })

      setStatus({ kind: 'connecting', step: 'Waiting for signature (1 of 2) — securing your key locally…' })
      const wrapSignature = await walletClient.signMessage({
        account: walletAddress as `0x${string}`,
        message: buildWrapMessage(walletAddress),
      })
      await wrapAndStore({ walletAddress, accountIndex, apiKeyIndex, publicKey, privateKeyHex: privateKey, wrapSignature })

      setStatus({ kind: 'connecting', step: 'Waiting for signature (2 of 2) — registering with Lighter…' })
      const l1Sig = await walletClient.signMessage({
        account: walletAddress as `0x${string}`,
        message: signed.messageToSign,
      })

      const txInfo = { ...JSON.parse(signed.txInfo), L1Sig: l1Sig }

      setStatus({ kind: 'connecting', step: 'Submitting registration…' })
      const result = await submitLighterTx(signed.txType, JSON.stringify(txInfo))
      if (!result.ok) {
        clearStoredKey(walletAddress)
        throw new Error(result.message)
      }

      setStatus({ kind: 'connected', accountIndex, apiKeyIndex, publicKey })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      setStatus({ kind: 'ready' })
    }
  }

  const deposit = async () => {
    if (!walletAddress || !activeWallet || !publicClient || status.kind !== 'no-account') return
    setError('')
    try {
      const provider = await activeWallet.getEthereumProvider()
      const walletClient = createWalletClient({
        account: walletAddress as `0x${string}`,
        chain: nockChain,
        transport: custom(provider),
      })

      setStatus({ kind: 'depositing', step: 'Confirm the deposit in your wallet…' })
      const result = await executeLighterDeposit({ walletClient, publicClient, amountUsdg: depositAmount })
      if (result.error) throw new Error(result.error)

      // The account won't appear until the next rollup batch commits (~1/min), so poll
      // rather than expecting it immediately. This is expected latency, not an error.
      setStatus({ kind: 'depositing', step: 'Confirming on Lighter — this can take up to a minute…' })
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000))
        const account = await lookupLighterAccount(walletAddress)
        if (account) {
          setDepositAmount('')
          setStatus({ kind: 'ready' })
          return
        }
      }
      throw new Error(
        'Your deposit was sent but the Lighter account has not appeared yet. Give it a minute and reopen Settings — it should show up.',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      setStatus({ kind: 'no-account' })
    }
  }

  // Add more USDG margin to an EXISTING Lighter account (same deposit contract call, which
  // just tops up collateral). No account-creation polling needed since the account exists.
  const addFunds = async () => {
    if (!walletAddress || !activeWallet || !publicClient || !addAmount) return
    setError('')
    setAddDone(false)
    setAddBusy(true)
    try {
      const provider = await activeWallet.getEthereumProvider()
      const walletClient = createWalletClient({
        account: walletAddress as `0x${string}`,
        chain: nockChain,
        transport: custom(provider),
      })
      const result = await executeLighterDeposit({ walletClient, publicClient, amountUsdg: addAmount })
      if (result.error) throw new Error(result.error)
      setAddAmount('')
      setAddDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setAddBusy(false)
    }
  }

  // Small "add funds" row shown once an account exists (ready / connected states).
  const addFundsRow = (
    <div className="mt-3 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">Add margin to your perps account</p>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="number"
          min="0"
          step="1"
          value={addAmount}
          onChange={(e) => {
            setAddAmount(e.target.value)
            setAddDone(false)
          }}
          placeholder="USDG amount, e.g. 20"
          className="min-w-0 flex-1 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <button
          type="button"
          disabled={addBusy || !addAmount}
          onClick={addFunds}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {addBusy && <Loader2 className="size-3 animate-spin" />}
          Add funds
        </button>
      </div>
      {addDone && <p className="mt-1.5 text-xs text-primary">Funds added — your perps margin will update shortly.</p>}
    </div>
  )

  return (
    <section className="mt-4 rounded-xl border border-border bg-card p-4">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Perps trading key
      </h2>
      <p className="mt-1.5 text-xs text-muted-foreground text-pretty">
        A separate key, generated in your browser, that lets you trade on Lighter under
        your own account. It's encrypted with your wallet and never sent to Nock.
      </p>

      {status.kind === 'checking' && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Checking availability…
        </div>
      )}

      {status.kind === 'restricted' && (
        <p className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-xs text-muted-foreground text-pretty">
          Perps aren&apos;t available in your region. Perpetual futures are restricted for
          retail in {status.label} (a regulatory restriction, not a technical one), so
          deposits and trading are disabled here. Nock still supports tokenized stocks,
          token swaps, and yield for you.
        </p>
      )}

      {status.kind === 'no-account' && (
        <div className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
          <p className="text-xs text-muted-foreground text-pretty">
            No Lighter account found for this wallet yet. Deposit USDG to create one —
            this funds your trading balance and sets up the account in one step.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <input
              type="number"
              min="0"
              step="1"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="USDG amount, e.g. 10"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            <button
              type="button"
              disabled={!depositAmount}
              onClick={deposit}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              Deposit
            </button>
          </div>
        </div>
      )}

      {status.kind === 'depositing' && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin shrink-0" />
          {status.step}
        </div>
      )}

      {status.kind === 'ready' && (
        <>
          <button
            type="button"
            onClick={setup}
            className="mt-3 flex w-full items-center justify-center rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/60"
          >
            Set up trading key
          </button>
          {addFundsRow}
        </>
      )}

      {status.kind === 'connecting' && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin shrink-0" />
          {status.step}
        </div>
      )}

      {status.kind === 'connected' && (
        <div className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Lighter account</p>
              <p className="font-mono text-sm text-foreground">
                #{status.accountIndex} · key {status.apiKeyIndex} · {status.publicKey.slice(0, 8)}…{status.publicKey.slice(-6)}
              </p>
            </div>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-primary" />
              Connected
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              if (walletAddress) clearStoredKey(walletAddress)
              setStatus({ kind: 'ready' })
            }}
            className="mt-2.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Reset
          </button>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Reset forgets this key on this device only — it stays registered on Lighter
            until you replace it with a new one.
          </p>
          {addFundsRow}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}
