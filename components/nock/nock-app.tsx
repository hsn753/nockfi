'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWallets, usePrivy, getIdentityToken } from '@privy-io/react-auth'
import { usePublicClient } from 'wagmi'
import { erc20Abi, formatUnits, parseUnits, createWalletClient, custom } from 'viem'
import { Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { INSTANT_SWAPS_ENABLED } from '@/lib/feature-flags'
import {
  localChatStorage,
  type ConversationSummary,
} from '@/lib/chat-storage'
import { executeSwap } from '@/lib/execute-swap'
import { executeUniswapV4Swap } from '@/lib/execute-uniswap-swap'
import { executeCollateralSequence } from '@/lib/execute-collateral'
import { resolveSendGasPrice } from '@/lib/gas'
import { NATIVE_ETH_ADDRESS } from '@/lib/get-swap-quote'
import { nockChain } from '@/lib/chain'
import { startBridgeWatch, getPendingBridge, clearBridgeWatch, type PendingBridge } from '@/lib/bridge-tracker'
import { placeClientPerpsOrder, hasClientPerpsKey } from '@/lib/lighter-order'
import {
  getAgent,
  initialMessages,
  type ActionPreview,
  type AgentId,
  type AttentionItem,
  type ChatMessage,
  type NavView,
  type Position,
} from './data'
import dynamic from 'next/dynamic'
import { Sidebar } from './sidebar'
import { ChatPanel } from './chat-panel'
import { DashboardPanel } from './dashboard-panel'
import { BottomNav } from './bottom-nav'

// Agents / Activity / Settings are only reachable by switching views (chat is the default),
// so code-split them out of the initial bundle — the browser downloads and parses their JS
// only when the user actually opens one, shrinking first-load work. Client-only (ssr:false)
// since they all rely on wallet hooks; a light fallback shows during the (usually instant) fetch.
const viewFallback = () => <div className="flex-1" />
const AgentsView = dynamic(() => import('./agents-view').then((m) => m.AgentsView), { ssr: false, loading: viewFallback })
const ActivityView = dynamic(() => import('./activity-view').then((m) => m.ActivityView), { ssr: false, loading: viewFallback })
const SettingsView = dynamic(() => import('./settings-view').then((m) => m.SettingsView), { ssr: false, loading: viewFallback })

// Portfolio value calculation - will be real once we have price feeds
const PORTFOLIO_BASE = 0
const DEMO_IDS = new Set(['m1', 'm2'])

export function NockApp() {
  const [activeView, setActiveView] = useState<NavView>('chat')
  const [selectedAgent, setSelectedAgent] = useState<AgentId | null>(null)
  const [dashboardTab, setDashboardTab] = useState<
    'overview' | 'balances' | 'activity'
  >('overview')
  const [drawerOpen, setDrawerOpen] = useState(false)

  const { wallets } = useWallets()
  const { user: privyUser, ready: privyReady, authenticated: privyAuthed, getAccessToken } = usePrivy()

  // Fetch the Privy tokens for an authenticated request. The ACCESS token is the reliable one
  // — always available for a logged-in session — and the server verifies it. The identity
  // token is best-effort: it's an opt-in Privy feature the current app doesn't issue (returns
  // null), so we send it when present but never depend on it. getAccessToken() also refreshes
  // the session, so this doubles as the refresh.
  const getAuthTokens = useCallback(async (): Promise<{ accessToken: string | null; identityToken: string | null }> => {
    let accessToken: string | null = null
    for (let attempt = 0; attempt < 3 && !accessToken; attempt++) {
      try {
        accessToken = await getAccessToken()
      } catch {
        /* retry */
      }
      if (!accessToken) await new Promise((r) => setTimeout(r, 250))
    }
    let identityToken: string | null = null
    try {
      identityToken = await getIdentityToken()
    } catch {
      identityToken = null
    }
    return { accessToken, identityToken }
  }, [getAccessToken])
  const publicClient = usePublicClient()

  // Privy's own wallet.chainId (CAIP-2, e.g. "eip155:4663") is the authoritative source
  // for what network a connected wallet is actually on — wagmi's useChainId/
  // useWalletClient go through a bridge that, per Privy's own docs, does NOT update its
  // cached provider when the network is switched outside the dApp (e.g. directly in the
  // MetaMask extension UI, which is the normal way a user adds/activates a custom
  // network). Seen in prod: a wallet switched to Robinhood Chain natively in
  // MetaMask still read as the wrong network here when checked through wagmi's hooks.
  const activeWallet = wallets[0]
  const walletChainId = activeWallet?.chainId ? Number(activeWallet.chainId.split(':')[1]) : undefined
  const isOnRobinhoodChain = walletChainId === nockChain.id

  // Proactively switch a connected wallet onto Robinhood Chain instead of waiting for a
  // swap attempt to fail. Some wallets (MetaMask included) don't auto-activate a network
  // just because it was added — the user can add it as a custom network and still be
  // sitting on a different one.
  useEffect(() => {
    if (activeWallet && !isOnRobinhoodChain) {
      activeWallet.switchChain(nockChain.id).catch(() => {
        // User declined, or the wallet doesn't support programmatic switching — handleLoose
        // below still catches this at execution time with a clear message.
      })
    }
  }, [activeWallet, isOnRobinhoodChain])

  // The delegated embedded "instant swap" wallet (see Settings) is a separate address
  // used only when actually EXECUTING a swap without a mobile prompt — see handleLoose
  // below. It must never become the app's general wallet identity: per
  // privy-wallet-how-it-should-work.md, the connected external wallet stays the default
  // for everything else (holdings, portfolio, quotes). Getting this backwards previously
  // meant a user who'd ever enabled instant swaps had Nock silently reading balances from
  // the unfunded embedded wallet instead of whatever wallet they'd actually connected —
  // showing $0 even when the connected wallet plainly held funds.
  const delegatedWallet = useMemo(() => {
    // Instant Swaps is hidden/disabled until the next version (lib/feature-flags.ts). With it
    // off, never detect a delegated wallet, so every swap routes through normal external
    // signing (per-transaction approval) even for anyone who enabled it before it was hidden.
    if (!INSTANT_SWAPS_ENABLED) return undefined
    const match = privyUser?.linkedAccounts?.find(
      (a: any) => a.type === 'wallet' && a.walletClientType === 'privy' && a.chainType === 'ethereum' && a.delegated,
    ) as { address: string; id?: string } | undefined
    return match
  }, [privyUser])

  const walletAddress = wallets[0]?.address

  // Only actually true instant-swap usage when the CONNECTED wallet is itself the
  // delegated one (e.g. an embedded-wallet-only login) — not just "a delegated wallet
  // exists somewhere on this account." Seen in prod: a user with both a funded
  // external wallet and a separate, unfunded delegated wallet got "not enough USDG"
  // on a swap their connected wallet's balance plainly covered, because execution
  // silently preferred the delegated wallet as signer just because one existed,
  // completely independent of which wallet the quote/balance check actually used.
  const isUsingDelegatedWallet =
    !!delegatedWallet && !!walletAddress && delegatedWallet.address.toLowerCase() === walletAddress.toLowerCase()

  // Debug logging
  useEffect(() => {
    console.log('[Nock] Wallets detected:', wallets)
    console.log('[Nock] Wallet address:', walletAddress)
  }, [wallets, walletAddress])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isRobinLoading, setIsRobinLoading] = useState(false)
  const [attention, setAttention] = useState<AttentionItem[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [addedValue, setAddedValue] = useState(0)
  const [realPortfolioValue, setRealPortfolioValue] = useState(0)
  const [weeklyChangePct, setWeeklyChangePct] = useState<number | null>(null)
  const [pendingBridge, setPendingBridge] = useState<PendingBridge | null>(null)

  const fetchPortfolioValue = useCallback(async (): Promise<number | null> => {
    if (!walletAddress) return null
    try {
      console.log('[Nock] Fetching balances for portfolio value...')
      // Balances (incl. perps) + yield positions in parallel — both cached server-side.
      const [res, yieldRes] = await Promise.all([
        fetch(`/api/balances?address=${walletAddress}`),
        fetch(`/api/yield-positions?address=${walletAddress}`).catch(() => null),
      ])

      if (!res.ok) {
        console.error('[Nock] Balance fetch failed:', res.status)
        return null
      }

      const data = await res.json()
      console.log('[Nock] Balances received:', data.balances)

      // Live yield (Morpho) supply positions for the dashboard — best-effort.
      type YieldPos = { market: string; suppliedUsd: number; apyPct: number | null }
      const yieldPositions: YieldPos[] =
        yieldRes && yieldRes.ok ? ((await yieldRes.json())?.positions ?? []) : []

      // Perps (Lighter) account, folded in by /api/balances.
      type PerpsPos = { symbol: string; side: 'long' | 'short'; notionalUsd: number; leverage: number | null; unrealizedPnlUsd: number }
      const perps: { hasAccount?: boolean; equityUsd?: number; positions?: PerpsPos[] } | null = data.perps ?? null
      const perpsEquity = perps?.hasAccount ? (perps.equityUsd ?? 0) : 0

      const walletTotal = (data.balances || []).reduce(
        (sum: number, b: { usdValue?: number | null }) => sum + (b.usdValue ?? 0),
        0,
      )

      // Stock posted as loan collateral is still the user's asset, net of the
      // debt against it. Without this the portfolio total silently dropped by
      // the full collateral value the moment a loan opened (seen live: a $2
      // borrow read as a $3 portfolio loss). The same fetch drives the loan
      // position card and the Vault Agent's liquidation-risk attention item —
      // the docs' "anything Vault flags surfaces in Needs Attention".
      type LoanPos = {
        stockSymbol: string
        collateralAmount: string
        collateralValueUsd: number
        borrowedUsd: number
        ltvUtilizationPct: number
        liquidationPriceUsd: number | null
      }
      const loans: LoanPos[] = data.collateralPositions || []
      const netCollateral = loans.reduce((s, p) => s + (p.collateralValueUsd - p.borrowedUsd), 0)
      const total = walletTotal + netCollateral + perpsEquity

      setPositions((prev) => {
        // Rebuild the real, on-chain-derived cards (loan / perps / yield) from fresh data
        // each refresh so they PERSIST across reloads; keep any other cards untouched.
        const kept = prev.filter(
          (p) => !p.id.startsWith('loan-') && !p.id.startsWith('perps-') && !p.id.startsWith('yield-'),
        )
        const loanCards: Position[] = loans.map((p) => ({
          id: `loan-${p.stockSymbol}`,
          agent: 'stock' as AgentId,
          title: `${p.stockSymbol} loan — ${p.collateralAmount} ${p.stockSymbol} posted`,
          subtitle: `Debt $${p.borrowedUsd.toFixed(2)} · liquidation at $${p.liquidationPriceUsd?.toFixed(2) ?? 'n/a'}`,
          value: `$${(p.collateralValueUsd - p.borrowedUsd).toFixed(2)} net`,
          meta: `${p.ltvUtilizationPct.toFixed(0)}% of liquidation ceiling`,
          metaPositive: p.ltvUtilizationPct < 80,
        }))
        const perpsCards: Position[] = (perps?.positions ?? []).map((p) => ({
          id: `perps-${p.symbol}`,
          agent: 'perps' as AgentId,
          title: `${p.symbol} ${p.side === 'short' ? 'short' : 'long'} — $${p.notionalUsd.toFixed(2)} notional`,
          subtitle: `${p.leverage ? `${p.leverage}x · ` : ''}Perps agent · active`,
          value: `${p.unrealizedPnlUsd >= 0 ? '+' : '−'}$${Math.abs(p.unrealizedPnlUsd).toFixed(2)} PnL`,
          meta: p.leverage ? `${p.leverage}x leverage` : 'perpetual',
          metaPositive: p.unrealizedPnlUsd >= 0,
        }))
        const yieldCards: Position[] = yieldPositions.map((p) => ({
          id: `yield-${p.market}`,
          agent: 'yield' as AgentId,
          title: `${p.market} — $${p.suppliedUsd.toFixed(2)} supplied`,
          subtitle: `Yield agent · active`,
          value: `$${p.suppliedUsd.toFixed(2)}`,
          meta: p.apyPct != null ? `${p.apyPct.toFixed(2)}% APY` : 'earning',
          metaPositive: true,
        }))
        return [...perpsCards, ...loanCards, ...yieldCards, ...kept]
      })
      setAttention((prev) => {
        const withoutLoanRisk = prev.filter((a) => !a.id.startsWith('loan-risk-') && !a.id.startsWith('loan-event-'))
        const risky = loans.filter((p) => p.ltvUtilizationPct >= 80)
        const liveSymbols = new Set(risky.map((p) => p.stockSymbol))
        // Server-persisted events from the monitoring sweep cover what happened
        // while the app was closed. A live item for the same symbol is fresher and
        // wins; a persisted event whose loan looks healthy NOW still shows (with
        // its timestamp) until the sweep resolves it — the user should know the
        // line was crossed even if the price recovered.
        type RiskEvent = { stockSymbol: string; ltvUtilizationPct: string; liquidationPriceUsd: string | null; createdAt: string }
        const events: RiskEvent[] = (data.riskEvents || []).filter((e: RiskEvent) => !liveSymbols.has(e.stockSymbol))
        return [
          ...risky.map((p) => ({
            id: `loan-risk-${p.stockSymbol}`,
            agent: 'vault' as AgentId,
            title: `${p.stockSymbol} loan is close to liquidation`,
            subtitle: `Debt is at ${p.ltvUtilizationPct.toFixed(0)}% of the ceiling. Liquidation if ${p.stockSymbol} falls to $${p.liquidationPriceUsd?.toFixed(2) ?? 'n/a'}. Repay some debt or post more collateral.`,
            meta: 'At risk',
          })),
          ...events.map((e) => ({
            id: `loan-event-${e.stockSymbol}`,
            agent: 'vault' as AgentId,
            title: `${e.stockSymbol} loan crossed the risk line while you were away`,
            subtitle: `Hit ${parseFloat(e.ltvUtilizationPct).toFixed(0)}% of the liquidation ceiling on ${new Date(e.createdAt).toLocaleString()}. Check the position and consider repaying or adding collateral.`,
            meta: 'Review',
          })),
          ...withoutLoanRisk,
        ]
      })

      setRealPortfolioValue(total)
      // Real week-over-week change from daily snapshots — null (line hidden)
      // until at least one day of history exists.
      setWeeklyChangePct(typeof data.weeklyChangePct === 'number' ? data.weeklyChangePct : null)
      return total
    } catch (err) {
      console.error('[Nock] Error fetching portfolio value:', err)
      return null
    }
  }, [walletAddress])

  // Fetch real portfolio value when wallet connects, and pick up any bridge watch
  // left over from before a refresh.
  useEffect(() => {
    if (!walletAddress) {
      setRealPortfolioValue(0)
      setPendingBridge(null)
      return
    }
    fetchPortfolioValue()
    setPendingBridge(getPendingBridge(walletAddress))
  }, [walletAddress, fetchPortfolioValue])

  const BRIDGE_ATTENTION_ID = 'bridge-pending'

  // While a bridge is pending, poll for the Robinhood Chain balance to actually
  // increase — that's the only signal available since bridging happens entirely
  // on Ethereum L1 outside this app, with no transaction of ours to await.
  useEffect(() => {
    if (!walletAddress || !pendingBridge) {
      setAttention((prev) => prev.filter((a) => a.id !== BRIDGE_ATTENTION_ID))
      return
    }

    setAttention((prev) =>
      prev.some((a) => a.id === BRIDGE_ATTENTION_ID)
        ? prev
        : [
            {
              id: BRIDGE_ATTENTION_ID,
              agent: 'swap',
              title: 'Bridge to Robinhood Chain in progress',
              subtitle: 'Typically arrives within about 10 minutes',
              meta: 'Watching',
            },
            ...prev,
          ],
    )

    const interval = setInterval(async () => {
      const total = await fetchPortfolioValue()
      if (total !== null && total > pendingBridge.snapshotUsd + 0.01) {
        clearBridgeWatch(walletAddress)
        setPendingBridge(null)
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-bridge`,
            role: 'robin',
            text: `Your bridged funds have arrived on Robinhood Chain. Your balance went from about $${pendingBridge.snapshotUsd.toFixed(2)} to $${total.toFixed(2)}. Ready to put it to work whenever you are.`,
          },
        ])
      }
    }, 20000)

    return () => clearInterval(interval)
  }, [walletAddress, pendingBridge, fetchPortfolioValue])

  // Chat history
  const conversationIdRef = useRef<string | null>(null)
  const [history, setHistory] = useState<ConversationSummary[]>([])

  useEffect(() => {
    setHistory(localChatStorage.list())
  }, [])

  // Auto-save whenever messages change, skipping empty chats.
  useEffect(() => {
    if (messages.length === 0) return
    const firstUserMsg = messages.find((m) => m.role === 'user')
    if (!firstUserMsg) return

    if (!conversationIdRef.current) {
      conversationIdRef.current = `conv-${Date.now()}`
    }
    const existing = localChatStorage.get(conversationIdRef.current)
    localChatStorage.save({
      id: conversationIdRef.current,
      title: firstUserMsg.text.slice(0, 60),
      createdAt: existing?.createdAt ?? Date.now(),
      messages,
    })
    setHistory(localChatStorage.list())
  }, [messages])

  const portfolioValue = (realPortfolioValue + addedValue).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  })

  const handleNavigate = useCallback((view: NavView) => {
    setActiveView(view)
    setSelectedAgent(null)
    setDrawerOpen(false)
  }, [])

  const handleSelectAgent = useCallback((id: AgentId | null) => {
    if (id) {
      setActiveView('agents')
      setSelectedAgent(id)
    } else {
      setSelectedAgent(null)
    }
    setDrawerOpen(false)
  }, [])

  // Always points at the CURRENT handleLoose — handleSend and handleLoose have
  // different dependency arrays, so a direct closure capture could go stale (the exact
  // failure mode behind two earlier wallet bugs in this file). Assigned right after
  // handleLoose's declaration below.
  const handleLooseRef = useRef<((actionId: string) => Promise<void>) | null>(null)

  // Action ids currently mid-execution. A card can be confirmed from two places at once
  // (the Confirm button and typing "confirm"/"loose"), or double-tapped — without this
  // guard the same swap could be broadcast twice. One in-flight execution per card.
  const executingActionsRef = useRef<Set<string>>(new Set())

  const handleSend = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = { id: `${Date.now()}-u`, role: 'user', text }

      // Users type the button words instead of clicking — one production incident came
      // from exactly that. Typed commands act on the most recent actionable card.
      // "loose"/"draw" kept as aliases from the old button naming.
      const command = text.trim().toLowerCase().replace(/[.!]+$/, '')
      const confirmWords = ['confirm', 'confirm it', 'loose', 'loose it']
      const reviewWords = ['review', 'review it', 'draw', 'draw it']
      const isLooseOrDraw = confirmWords.includes(command) || reviewWords.includes(command)
      // Bare confirmations users actually typed in production trying to execute a
      // pending action ("yes proceed" fabricated an execution claim from the model,
      // twice). Deterministic local handling — never let an affirmative reach the AI
      // while a card is waiting, and never auto-execute on an ambiguous "yes" either.
      const isBareAffirmative =
        /^(yes|yep|yeah|ok|okay|sure|confirm|proceed|go ahead|do it|yes please|yes sure|yes confirm|yes proceed|yes continue|please proceed|yes go ahead|confirm and proceed|yes confirm and proceed)$/.test(
          command.replace(/\s+/g, ' '),
        )

      if (isLooseOrDraw || isBareAffirmative) {
        const lastActionable = [...messages].reverse().find(
          (m): m is Extract<ChatMessage, { role: 'robin' }> =>
            m.role === 'robin' && !!m.action && (m.action.status === 'pending' || m.action.status === 'reviewing'),
        )
        if (lastActionable?.action) {
          setMessages((prev) => [...prev, userMsg])
          if (confirmWords.includes(command)) {
            void handleLooseRef.current?.(lastActionable.action.id)
          } else if (reviewWords.includes(command)) {
            handleDraw(lastActionable.action.id)
          } else {
            // Affirmative, but "yes" must never fire a real transaction on its own —
            // answer locally and deterministically instead of letting the AI respond.
            setMessages((prev) => [
              ...prev,
              {
                id: `${Date.now()}-confirm-hint`,
                role: 'robin',
                text: 'To execute it, press the Confirm button on the action card above, or type "confirm". I never run anything from a yes alone.',
              },
            ])
          }
          return
        }
        // No actionable card — fall through to the AI, which is instructed to explain
        // there's nothing pending rather than invent an outcome.
      }

      // Privy takes a moment to restore the session after a page load/refresh — sending
      // a message in that brief window meant walletAddress was still undefined, which
      // read as "please connect your wallet" even though a wallet plainly was connected
      // and the very next attempt (once hydration finished) worked fine. Refuse to send
      // with a stale/incomplete wallet state instead of guessing.
      if (!privyReady) {
        setMessages((prev) => [
          ...prev,
          userMsg,
          {
            id: `${Date.now()}-notready`,
            role: 'robin',
            text: "Still finishing loading your wallet. Give it a second and try that again.",
          },
        ])
        return
      }

      setMessages((prev) => [...prev, userMsg])
      setIsRobinLoading(true)

      try {
        const history: ChatMessage[] = [
          ...messages.filter((m) => !DEMO_IDS.has(m.id)),
          userMsg,
        ]

        console.log('[Nock] Sending to API - wallet address:', walletAddress)

        // Fetched fresh right here rather than read from a cached hook value — the
        // reactive useIdentityToken() hook was known to not reliably reflect a
        // usable token for an already-connected session, causing every authenticated
        // request to fail with "missing identity token" even right after a hard refresh.
        // getIdentityToken() is Privy's own async getter for exactly this use case.
        // Refresh + retry so a stale/expired identity token on a still-valid session doesn't
        // intermittently fail the request (one message works, the next says "missing token").
        // Only truly returns null when the session genuinely can't produce a token.
        const { identityToken, accessToken } = await getAuthTokens()

        const res = await fetch('/api/robin', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Privy-Identity-Token': identityToken ?? '',
            'X-Privy-Access-Token': accessToken ?? '',
          },
          body: JSON.stringify({ messages: history, walletAddress }),
        })

        const data = (await res.json().catch(() => null)) as {
          text: string
          action?: ActionPreview
          bridgeInfo?: { link: string; sourceChain: string; destinationChain: string; etaMinutes: number }
          suggestions?: string[]
        } | null

        if (!res.ok || !data) {
          // 401/403 = the session isn't valid (e.g. stale after the Privy migration). Tell the
          // user to reconnect rather than showing an opaque error. The server's own message is
          // already user-friendly, so prefer it when present.
          const authProblem = res.status === 401 || res.status === 403
          const msg = data?.text
            || (authProblem
              ? 'Your session has expired. Please disconnect and reconnect your wallet, then try again.'
              : 'Something went wrong. Please try again.')
          setMessages((prev) => [...prev, { id: `${Date.now()}-r`, role: 'robin', text: msg }])
          return
        }

        const { text: replyText, action, bridgeInfo, suggestions } = data

        const replyMsg: ChatMessage = {
          id: `${Date.now()}-r`,
          role: 'robin',
          text: replyText,
          ...(action ? { action } : {}),
          ...(bridgeInfo ? { bridgeInfo } : {}),
          ...(suggestions && suggestions.length ? { suggestions } : {}),
        }

        setMessages((prev) => [...prev, replyMsg])

        // Robin just gave out the bridge link — start watching for the balance to
        // actually move so we can tell the user once funds land, without them having
        // to keep asking.
        if (bridgeInfo && walletAddress) {
          const snapshotUsd = (await fetchPortfolioValue()) ?? realPortfolioValue
          startBridgeWatch(walletAddress, snapshotUsd)
          setPendingBridge({ startedAt: Date.now(), snapshotUsd })
        }
      } catch {
        setMessages((prev) => [
          ...prev,
          { id: `${Date.now()}-r`, role: 'robin', text: 'Something went wrong. Please try again.' },
        ])
      } finally {
        setIsRobinLoading(false)
      }
    },
    // walletAddress must be a real dependency here, not swallowed by the broader
    // suppression below — this was the actual root cause of "sidebar
    // clearly shows a connected wallet, but Robin says none is connected": this
    // callback's closure only got recreated when messages/privyReady changed, so it
    // could keep using a stale (undefined) walletAddress captured before the wallet
    // connected, until some unrelated state change happened to force a new closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, privyReady, walletAddress],
  )

  const handleDraw = useCallback((actionId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.role === 'robin' && m.action && m.action.id === actionId
          ? { ...m, action: { ...m.action, status: 'reviewing' as const } }
          : m,
      ),
    )
  }, [])

  const handleLoose = useCallback(async (actionId: string) => {
    // Reject a duplicate confirm for a card already executing (button + typed "confirm",
    // or a fast double-tap). Released at the two exit points below: the early !action
    // return, and the end of the callback (the real-execution branch is fully awaited
    // before then, so the slot is held for the entire broadcast+verify window).
    if (executingActionsRef.current.has(actionId)) return
    executingActionsRef.current.add(actionId)

    // Enter confirming state.
    setMessages((prev) =>
      prev.map((m) =>
        m.role === 'robin' && m.action && m.action.id === actionId
          ? { ...m, action: { ...m.action, status: 'confirming' } }
          : m,
      ),
    )

    // Get the action to execute
    const targetMsg = messages.find(
      (m) => m.role === 'robin' && m.action?.id === actionId,
    ) as Extract<ChatMessage, { role: 'robin' }> | undefined
    const action = targetMsg?.action

    if (!action) {
      console.error('Action not found:', actionId)
      executingActionsRef.current.delete(actionId)
      return
    }

    // PERPS EXECUTION. Two paths:
    //  • CLIENT-SIDE (non-custodial): if this wallet has a registered Lighter key (set up
    //    in Settings → Perps trading key), the order is signed IN THE BROWSER with that key
    //    and submitted straight to Lighter — Nock never signs or holds anything. Preferred.
    //  • LEGACY EXECUTOR: otherwise fall back to the server-side executor (/api/execute-perps),
    //    which signs with the shared account. Retired once everyone is on the client path.
    // Either way success is keyed on the returned orderId (no on-chain txHash to verify),
    // and the jurisdiction geofence still gates it (client path: Lighter's own IP geoblock).
    if (action.agent === 'perps' && (action as any).routeVia === 'perps') {
      const perps = (action as any).perps || {}
      try {
        let data: { orderId?: string; avgPrice?: number; baseFilled?: number; notionalUsd?: number; error?: string }
        if (walletAddress && activeWallet && hasClientPerpsKey(walletAddress)) {
          // Non-custodial path — sign + submit in the browser with the user's own key.
          const result = await placeClientPerpsOrder({
            walletAddress: walletAddress as string,
            activeWallet: activeWallet as any,
            symbol: perps.symbol,
            side: perps.side,
            marginUsd: Number(perps.marginUsd),
            leverage: Number(perps.leverage),
            markPrice: Number(perps.markPrice),
            maxSlippageBps: perps.maxSlippageBps,
            reduceOnly: !!perps.reduceOnly,
          })
          if (!result.ok) throw new Error(result.error)
          data = result
        } else {
          // No trading key on this device — perps are non-custodial and require it. Point
          // the user to set it up rather than silently failing on the legacy executor.
          throw new Error('You need a perps trading key on this device first. Open Settings → "Perps trading key" and set it up, then press Confirm again.')
        }

        setMessages((prev) => {
          const agent = getAgent('perps')
          const updated = prev.map((m) =>
            m.role === 'robin' && m.action && m.action.id === actionId
              ? { ...m, action: { ...m.action, status: 'executed' as const } }
              : m,
          )
          const confirm: ChatMessage = {
            id: `${Date.now()}-c`,
            role: 'robin',
            text: perps.reduceOnly
              ? `Done — ${perps.symbol} position closed at ~$${Number(data.avgPrice).toLocaleString('en-US', { maximumFractionDigits: 6 })} (${Number(data.notionalUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDG notional). Order ${String(data.orderId).slice(0, 12)}…`
              : `Done — ${perps.side === 'short' ? 'short' : 'long'} position opened on ${perps.symbol} at ~$${Number(data.avgPrice).toLocaleString('en-US', { maximumFractionDigits: 6 })} (${Number(data.notionalUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDG notional). Order ${String(data.orderId).slice(0, 12)}…`,
          }
          // Optimistic card using the SAME id format (perps-<symbol>) that
          // fetchPortfolioValue rebuilds from real on-chain data, so there's no duplicate
          // and it persists across refresh once the real read lands.
          const sym = String(perps.symbol)
          if (perps.reduceOnly) {
            setPositions((p) => p.filter((x) => x.id !== `perps-${sym}`))
          } else {
            const newPosition: Position = {
              id: `perps-${sym}`,
              agent: 'perps',
              title: `${sym} ${perps.side === 'short' ? 'short' : 'long'} — $${Number(data.notionalUsd).toFixed(2)} notional`,
              subtitle: `${perps.leverage ? `${perps.leverage}x · ` : ''}${agent.name} · active`,
              value: '+$0.00 PnL',
              meta: perps.leverage ? `${perps.leverage}x leverage` : 'perpetual',
              metaPositive: true,
            }
            setPositions((p) => [newPosition, ...p.filter((x) => x.id !== `perps-${sym}`)])
          }
          setAttention((att) => att.filter((x) => x.agent !== 'perps'))
          return [...updated, confirm]
        })
        // Refresh from real data shortly after — the balances cache (15s) needs a beat to
        // reflect the new/closed position; the optimistic card above covers the gap.
        fetchPortfolioValue()
        setTimeout(() => { void fetchPortfolioValue() }, 16_000)
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'Unknown error'
        setMessages((prev) => [
          ...prev.map((m) =>
            m.role === 'robin' && m.action && m.action.id === actionId
              ? { ...m, action: { ...m.action, status: 'pending' as const } }
              : m,
          ),
          {
            id: `${Date.now()}-error`,
            role: 'robin',
            text: `The position was not ${perps.reduceOnly ? 'closed' : 'opened'}: ${rawMessage} Nothing was placed — press Confirm to try again.`,
          },
        ])
      }
      executingActionsRef.current.delete(actionId)
      return
    }

    // REAL SWAP/YIELD-DEPOSIT EXECUTION - NO MOCK DATA
    const isRealExecutionAgent = action.agent === 'swap' || action.agent === 'yield' || action.agent === 'stock'
    if (isRealExecutionAgent && (activeWallet || delegatedWallet)) {
      try {
        // Access token (reliable) + best-effort identity token; the server accepts either.
        // Reused for all the authenticated requests below.
        const { identityToken, accessToken } = await getAuthTokens()

        // Extract transaction data from action
        // The transaction data is stored in the action from the swap quote
        const txData = (action as any).transactionData
        const fromToken = ((action as any).fromToken || 'USDG') as string
        // fromAmount is a display-formatted string with thousands separators
        // (toLocaleString), which parseUnits cannot parse — strip them before any
        // numeric use. Confirmed this broke silently for any sell amount >= 1000.
        const fromAmount = ((action as any).amount || '0').replace(/,/g, '')
        const sellTokenAddress = (action as any).sellTokenAddress as string | undefined
        const sellTokenDecimals = (action as any).sellTokenDecimals as number | undefined

        // A yield withdrawal brings USDG back INTO the wallet — nothing is sold or
        // approved, so the sell-token balance/approval pre-flight below must be skipped
        // (a wallet with a 0 USDG balance can still have a large supplied position to
        // withdraw). Gas is still checked.
        const isWithdrawal = action.agent === 'yield' && (action as any).direction === 'withdraw'

        if (!txData) {
          throw new Error('No transaction data in action')
        }
        if (!sellTokenAddress || sellTokenDecimals === undefined) {
          throw new Error('Missing sell token details for this preview. Ask for a fresh quote and try again.')
        }

        // Stock-trade quotes carry an on-chain deadline (15 min). Confirming a
        // stale card would broadcast a guaranteed revert — gas spent, confusing
        // "slippage" error (exactly how the first live TSLA buy failed). Refuse
        // BEFORE broadcasting, with the honest reason.
        const quoteDeadline = (action as any).quoteDeadline as number | undefined
        if (quoteDeadline && Math.floor(Date.now() / 1000) > quoteDeadline) {
          throw new Error(
            'This trade preview has expired. Quotes are only valid for 15 minutes, and executing an expired one would fail on-chain and still cost gas. Nothing was sent. Ask for a fresh quote and confirm that one.',
          )
        }

        // The Privy session policy that constrains delegated (instant-swap) execution
        // only allows transactions to the 0x swap router — a Morpho lend/withdraw would
        // be rejected server-side by Privy. Decline honestly up front rather than
        // letting the user watch a doomed attempt. (Expanding the policy safely —
        // especially constraining the withdraw receiver — is its own follow-up.)
        if ((action.agent === 'yield' || (action as any).routeVia === 'uniswap-v4' || (action as any).routeVia === 'morpho-collateral') && isUsingDelegatedWallet) {
          throw new Error(
            'This action needs your connected external wallet. The instant-swap wallet is currently only authorized for 0x swaps. Connect your main wallet and try again.',
          )
        }

        // The wallet that will actually sign is always the connected wallet — the same
        // one get_wallet_holdings and the quote's taker (see app/api/robin/route.ts) use.
        // Only when that connected wallet IS ITSELF the delegated one (see
        // isUsingDelegatedWallet above) does execution route through the server-side
        // signer below instead of a mobile/extension prompt — never based on a delegated
        // wallet merely existing elsewhere on the account.
        const signerAddress = walletAddress

        // Pre-flight balance check — works for ANY sell token (verified or not) since it
        // uses the address/decimals the quote actually resolved, not a symbol lookup that
        // only covered the verified list (which silently skipped this whole check for any
        // memecoin/unverified token). Without this, a wallet that can't cover the
        // transaction tends to hang and time out instead of failing cleanly.
        if (publicClient && signerAddress && isWithdrawal) {
          // Withdrawal: only gas needs covering — the USDG comes back to the wallet.
          // Gas priced with the SAME resolver the executors send with — a pre-flight
          // priced at the (possibly stale) quoted gasPrice could pass and the real
          // send still fail on funds.
          const ethBalance = await publicClient.getBalance({ address: signerAddress as `0x${string}` })
          const gasCost = BigInt(txData.gas || '0') * (await resolveSendGasPrice(publicClient, txData.gasPrice))
          if (ethBalance < gasCost) {
            throw new Error(
              `Not enough ETH for gas. This withdrawal needs about ${formatUnits(gasCost, 18)} ETH for gas, but this wallet has ${formatUnits(ethBalance, 18)} ETH on Robinhood Chain.`,
            )
          }
        } else if (publicClient && signerAddress) {
          const isNativeEth = sellTokenAddress.toLowerCase() === NATIVE_ETH_ADDRESS.toLowerCase()
          const requiredAmount = parseUnits(fromAmount, sellTokenDecimals)
          const ethBalance = await publicClient.getBalance({ address: signerAddress as `0x${string}` })
          const gasCost = BigInt(txData.gas || '0') * (await resolveSendGasPrice(publicClient, txData.gasPrice))

          if (isNativeEth) {
            const totalNeeded = requiredAmount + gasCost
            if (ethBalance < totalNeeded) {
              throw new Error(
                `Not enough ETH. You need about ${formatUnits(totalNeeded, 18)} ETH (swap amount + gas) but this wallet has ${formatUnits(ethBalance, 18)} ETH on Robinhood Chain. Bridge more ETH in first.`,
              )
            }
          } else {
            const tokenBalance = await publicClient.readContract({
              address: sellTokenAddress as `0x${string}`,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [signerAddress as `0x${string}`],
            })
            if (tokenBalance < requiredAmount) {
              throw new Error(
                `Not enough ${fromToken}. You need ${fromAmount} ${fromToken} but this wallet has ${formatUnits(tokenBalance, sellTokenDecimals)} ${fromToken} on Robinhood Chain.`,
              )
            }
            if (ethBalance < gasCost) {
              throw new Error(
                `Not enough ETH for gas. This swap needs about ${formatUnits(gasCost, 18)} ETH for gas, but this wallet has ${formatUnits(ethBalance, 18)} ETH on Robinhood Chain.`,
              )
            }
          }
        }

        if (!publicClient) {
          throw new Error('Not connected to Robinhood Chain. Refresh and try again.')
        }

        console.log(action.agent === 'yield' ? (isWithdrawal ? 'Executing real withdrawal transaction...' : 'Executing real deposit transaction...') : 'Executing real swap transaction...')
        const result = isUsingDelegatedWallet
          ? await (async () => {
              const res = await fetch('/api/execute-delegated-swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Privy-Identity-Token': identityToken ?? '', 'X-Privy-Access-Token': accessToken ?? '' },
                body: JSON.stringify({
                  walletId: (delegatedWallet as any).id,
                  address: delegatedWallet.address,
                  transaction: txData,
                  sellToken: { address: sellTokenAddress, decimals: sellTokenDecimals, amount: fromAmount },
                }),
              })
              const data = await res.json()
              return { txHash: data.txHash as `0x${string}` | undefined, error: data.error as string | undefined }
            })()
          : await (async () => {
              if (!activeWallet) throw new Error('Please connect your wallet first to execute this action.')

              // Force the chain match right before signing rather than trusting the
              // cached wagmi walletClient — per Privy's own docs, switching a network
              // outside the dApp (e.g. directly in the MetaMask UI, the normal way a user
              // activates a newly-added custom network) does not update any existing
              // provider instance. A fresh provider fetched right now always reflects the
              // wallet's real current state, avoiding the disconnect/reconnect workaround.
              if (!isOnRobinhoodChain) {
                await activeWallet.switchChain(nockChain.id)
              }
              const provider = await activeWallet.getEthereumProvider()
              const freshWalletClient = createWalletClient({
                account: activeWallet.address as `0x${string}`,
                chain: nockChain,
                transport: custom(provider),
              })

              const executionParams = {
                walletClient: freshWalletClient,
                publicClient,
                // A withdrawal transfers nothing FROM the wallet, so no approval is
                // needed — amount '0' makes the allowance check a no-op (allowance
                // >= 0 always) without touching the executor's signature.
                amount: isWithdrawal ? '0' : fromAmount,
                sellTokenAddress,
                sellTokenDecimals,
                transaction: txData,
              }
              // Executor by route: Morpho collateral actions run an ordered multi-step
              // sequence; stock trades go through the Uniswap Universal Router (Permit2
              // settlement); everything else through the 0x router. Same downstream
              // audit/verify pipeline for all three.
              return (action as any).routeVia === 'morpho-collateral'
                ? executeCollateralSequence({
                    walletClient: freshWalletClient,
                    publicClient,
                    approval: (action as any).approval ?? null,
                    steps: (action as any).collateralSteps ?? [],
                  })
                : (action as any).routeVia === 'uniswap-v4'
                ? executeUniswapV4Swap(executionParams)
                : executeSwap(executionParams)
            })()

        // Phase 1 of the transaction audit trail — log this attempt regardless of
        // outcome, before verify-tx (below) fills in the real, independently-checked
        // result. Awaited (not fire-and-forget) deliberately: this was a
        // genuine race when unawaited — verify-tx's UPDATE could reach the database and
        // find no matching row yet (log-submission's INSERT hadn't landed), silently
        // updating zero rows and leaving verify_status permanently null even though the
        // check itself succeeded. Doesn't add real wait time from the user's perspective
        // either way, since verify-tx below is already awaited before any success/failure
        // message shows.
        try {
          await fetch('/api/transactions/log-submission', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Privy-Identity-Token': identityToken ?? '', 'X-Privy-Access-Token': accessToken ?? '' },
            body: JSON.stringify({
              txHash: result.txHash,
              walletAddress,
              signerAddress,
              signerType: isUsingDelegatedWallet ? 'delegated' : 'external',
              privyWalletId: isUsingDelegatedWallet ? (delegatedWallet as any)?.id : undefined,
              agent: action.agent,
              actionId: action.id,
              // A withdrawal flows market -> wallet, the reverse of a deposit. Without
              // this swap the audit row is indistinguishable from a deposit — confirmed
              // live: a real on-chain withdraw() was logged looking exactly like a
              // supply, which is ambiguous when auditing.
              fromTokenSymbol: isWithdrawal ? (action as any).toToken : fromToken,
              fromTokenAddress: isWithdrawal ? undefined : sellTokenAddress,
              fromAmount,
              toTokenSymbol: isWithdrawal ? fromToken : (action as any).toToken,
              quoteJson: action,
              broadcastStatus: !result.txHash || result.txHash === '0x'
                ? 'no_hash_returned'
                : result.error ? 'client_error' : 'submitted',
              errorMessage: result.error,
            }),
          })
        } catch (err) {
          console.error('[Nock] Could not log transaction submission:', err)
        }

        // Independent server-side confirmation is the ONLY thing allowed to decide
        // success/revert/didn't-happen — never result.error or result.txHash's own
        // internal receipt check alone. Seen twice in prod: a wallet client's own
        // receipt wait produced a false "reverted on-chain" conclusion (with a real-
        // looking hash) for a transaction that our own trusted RPC_URL-backed check, and
        // an independent public RPC, both say never existed at all — not reverted, not
        // found, period. Trusting result.error's own conclusion before this check (the
        // original bug here) meant a claimed revert could short-circuit past verification
        // entirely. If there's no hash at all, sendTransaction itself never got that far —
        // that's a real, different failure with nothing on-chain to check.
        if (!result.txHash || result.txHash === '0x') {
          throw new Error(result.error || 'No transaction hash was returned. The swap may not have been broadcast. Check your holdings before retrying.')
        }
        // Independent verification, with retry. A just-broadcast tx can be briefly
        // invisible to our RPC (propagation/indexing lag). Treating that transient
        // not-found as a failure — and reverting the card to a re-confirmable state —
        // is exactly what invited duplicate sends. So retry a few times; and if it
        // still can't be seen, park the card (leave it in its non-actionable confirming
        // state) and keep the in-flight lock held for this action id so it can NEVER be
        // re-sent, rather than reverting to pending. A reverted tx, by contrast, is a
        // definitive negative and is safe to surface as a normal failure.
        const shortHash = `${result.txHash.slice(0, 10)}...${result.txHash.slice(-8)}`
        let verifyData: { found?: boolean; status?: string } = {}
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 2500))
          const verifyRes = await fetch('/api/verify-tx', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-privy-identity-token': identityToken || '',
              'x-privy-access-token': accessToken || '',
            },
            body: JSON.stringify({ txHash: result.txHash, walletAddress }),
          })
          verifyData = await verifyRes.json()
          if (verifyData.found) break
        }
        if (!verifyData.found) {
          setMessages((prev) => [
            ...prev,
            {
              id: `${Date.now()}-verifying`,
              role: 'robin',
              text: `Your transaction is still being confirmed on Robinhood Chain (tx: ${shortHash}). It may just be finalizing. Check your holdings in a moment — do NOT send this again, or it could execute twice.`,
            },
          ])
          fetchPortfolioValue()
          // Return WITHOUT releasing the in-flight lock for this action id: the tx may
          // well have landed, so this card must never be re-executed.
          return
        }
        if (verifyData.status !== 'success') {
          throw new Error(`Transaction reverted on-chain (tx: ${shortHash}). Nothing was swapped, only gas was spent.`)
        }

        console.log(action.agent === 'yield' ? (isWithdrawal ? 'Withdrawal executed! TX Hash:' : 'Deposit executed! TX Hash:') : 'Swap executed! TX Hash:', result.txHash)

        // Update UI with success
        setMessages((prev) => {
          const agent = getAgent(action.agent)
          const updated = prev.map((m) =>
            m.role === 'robin' && m.action && m.action.id === actionId
              ? { ...m, action: { ...m.action, status: 'executed' as const } }
              : m,
          )

          const confirm: ChatMessage = {
            id: `${Date.now()}-c`,
            role: 'robin',
            text: `Done! ${action.agent === 'yield' ? (isWithdrawal ? 'Withdrawal' : 'Deposit') : action.agent === 'stock' ? 'Trade' : 'Swap'} executed on Robinhood Chain. TX: ${result.txHash ? `${result.txHash.slice(0, 10)}...${result.txHash.slice(-8)}` : 'confirmed'}`,
          }

          // Collateral actions don't get an action-based card: fetchPortfolioValue
          // (called right below) derives the authoritative live loan card from the
          // chain — it shows real debt/LTV and disappears when the loan closes,
          // which a frozen snapshot card can't do.
          if ((action as any).routeVia !== 'morpho-collateral') {
            const newPosition: Position = {
              id: `pos-${actionId}`,
              agent: action.agent,
              title: action.outcome.title,
              subtitle: `${agent.name} · active`,
              value: action.outcome.value,
              meta: action.outcome.meta,
              metaPositive: true,
            }

            setPositions((p) =>
              p.some((x) => x.id === newPosition.id) ? p : [newPosition, ...p],
            )
          }
          setAttention((att) => att.filter((x) => x.agent !== action.agent))

          return [...updated, confirm]
        })

        // Refetch the real on-chain total instead of estimating it by adding the
        // preview's outcome value on top of the last-known total. That estimate approach
        // was the exact mechanism behind an earlier bug (a swap into an unpriced token
        // added its raw token quantity as if it were a dollar figure) — a real swap now
        // always has a verified transaction behind it, so there's no reason not to just
        // ask the chain for the real number.
        fetchPortfolioValue()
      } catch (error) {
        const actionNoun = action.agent === 'yield' ? ((action as any).direction === 'withdraw' ? 'Withdrawal' : 'Deposit') : action.agent === 'stock' ? 'Trade' : 'Swap'
        console.error(`${actionNoun} execution failed:`, error)
        const rawMessage = error instanceof Error ? error.message : 'Unknown error'
        const isTimeout = /timeout/i.test(rawMessage)
        // A user declining the wallet prompt is not an error — surface it plainly instead
        // of dumping the raw viem stack (request args, calldata, contract call, docs link),
        // which read as a scary failure for a deliberate "not now".
        const isRejection = /reject|denied|user denied|declin|cancell?ed|user\s*rejected/i.test(rawMessage)
        // The RPC (Alchemy) rate-limits under rapid trading and throws "Rate Limit Hit /
        // Too many requests / 429". That's a transient network-busy state, not a failed
        // trade — surface it as such, not as the raw provider error.
        const isRateLimit = /rate limit|too many requests|\b429\b/i.test(rawMessage)
        const friendlyMessage = isRejection
          ? `You declined the ${actionNoun.toLowerCase()} in your wallet, so nothing happened and no funds moved. Press Confirm on the card whenever you're ready to try again.`
          : isRateLimit
          ? `The network is briefly busy and rate-limited the request, so nothing happened and no funds moved. Wait a few seconds, then press Confirm to try again.`
          : isTimeout
          ? `Your wallet didn't respond in time. This usually means a connected mobile wallet (like the Robinhood app over WalletConnect) either missed the approval notification or the session went stale. Check your phone for a pending approval, or try disconnecting and reconnecting your wallet, then attempt the ${actionNoun.toLowerCase()} again.`
          : `${actionNoun} failed: ${rawMessage}. Please try again.`
        setMessages((prev) => [
          ...prev.map((m) =>
            m.role === 'robin' && m.action && m.action.id === actionId
              ? { ...m, action: { ...m.action, status: 'pending' as const } }
              : m,
          ),
          {
            id: `${Date.now()}-error`,
            role: 'robin',
            text: friendlyMessage,
          },
        ])
      }
    } else if (!activeWallet && !delegatedWallet) {
      setMessages((prev) => [
        ...prev.map((m) =>
          m.role === 'robin' && m.action && m.action.id === actionId
            ? { ...m, action: { ...m.action, status: 'pending' as const } }
            : m,
        ),
        {
          id: `${Date.now()}-error`,
          role: 'robin',
          text: 'Please connect your wallet first to execute this action.',
        },
      ])
    } else {
      // Other agent types - keep mock behavior for now
      setTimeout(() => {
        setMessages((prev) => {
          const agent = getAgent(action.agent)
          const updated = prev.map((m) =>
            m.role === 'robin' && m.action && m.action.id === actionId
              ? { ...m, action: { ...m.action, status: 'executed' as const } }
              : m,
          )

          const confirm: ChatMessage = {
            id: `${Date.now()}-c`,
            role: 'robin',
            text: `Done. ${action.outcome.title} is now live and tracked in your dashboard under active positions.`,
          }

          const newPosition: Position = {
            id: `pos-${actionId}`,
            agent: action.agent,
            title: action.outcome.title,
            subtitle: `${agent.name} · active`,
            value: action.outcome.value,
            meta: action.outcome.meta,
            metaPositive: true,
          }

          setPositions((p) =>
            p.some((x) => x.id === newPosition.id) ? p : [newPosition, ...p],
          )
          setAttention((att) => att.filter((x) => x.agent !== action.agent))
          setAddedValue(
            (v) =>
              v + parseFloat(action.outcome.value.replace(/[^0-9.]/g, '') || '0'),
          )

          return [...updated, confirm]
        })
      }, 1200)
    }

    // Release the in-flight slot. The real-execution branch above is fully awaited by
    // the time we get here, so the slot was held for the entire broadcast+verify window;
    // the mock branch's setTimeout is fire-and-forget and carries no double-send risk.
    executingActionsRef.current.delete(actionId)
  }, [messages, activeWallet, isOnRobinhoodChain, delegatedWallet, fetchPortfolioValue, walletAddress])

  handleLooseRef.current = handleLoose

  const handleNewChat = useCallback(() => {
    setMessages([])
    conversationIdRef.current = null
    setActiveView('chat')
    setDrawerOpen(false)
  }, [])

  const handleLoadConversation = useCallback((id: string) => {
    const conv = localChatStorage.get(id)
    if (!conv) return
    setMessages(conv.messages)
    conversationIdRef.current = id
    setActiveView('chat')
    setDrawerOpen(false)
  }, [])

  const handleDeleteConversation = useCallback((id: string) => {
    localChatStorage.remove(id)
    setHistory(localChatStorage.list())
    if (conversationIdRef.current === id) {
      setMessages([])
      conversationIdRef.current = null
    }
  }, [])

  // ---- Rendering helpers ----
  function renderDesktopMain() {
    if (activeView === 'agents') {
      return (
        <AgentsView
          selectedAgent={selectedAgent}
          onSelect={handleSelectAgent}
          onChatWithRobin={() => setActiveView('chat')}
        />
      )
    }
    if (activeView === 'activity') {
      return (
        <div className="flex-1 overflow-hidden rounded-3xl bg-card">
          <ActivityView />
        </div>
      )
    }
    if (activeView === 'settings') {
      return (
        <div className="flex-1 overflow-hidden rounded-3xl bg-card">
          <SettingsView />
        </div>
      )
    }
    // chat / overview / dashboard -> split, each side its own floating card
    return (
      <div className="flex h-full min-h-0 flex-1 gap-3">
        <div className="min-w-0 flex-1 overflow-hidden rounded-3xl bg-background">
          <ChatPanel
            messages={messages}
            onSend={handleSend}
            onDraw={handleDraw}
            onLoose={handleLoose}
            onNewChat={handleNewChat}
            isLoading={isRobinLoading}
          />
        </div>
        <div className="hidden w-72 shrink-0 overflow-hidden rounded-3xl md:block lg:w-80">
          <DashboardPanel
            tab={dashboardTab}
            onTabChange={setDashboardTab}
            attention={attention}
            positions={positions}
            portfolioValue={portfolioValue}
            weeklyChangePct={weeklyChangePct}
          />
        </div>
      </div>
    )
  }

  function renderMobileMain() {
    switch (activeView) {
      case 'agents':
        return (
          <AgentsView
            selectedAgent={selectedAgent}
            onSelect={handleSelectAgent}
            onChatWithRobin={() => setActiveView('chat')}
          />
        )
      case 'activity':
        return <ActivityView />
      case 'settings':
        return <SettingsView />
      case 'dashboard':
      case 'overview':
        return (
          <DashboardPanel
            tab={dashboardTab}
            onTabChange={setDashboardTab}
            attention={attention}
            positions={positions}
            portfolioValue={portfolioValue}
            weeklyChangePct={weeklyChangePct}
          />
        )
      default:
        return (
          <ChatPanel
            messages={messages}
            onSend={handleSend}
            onDraw={handleDraw}
            onLoose={handleLoose}
            onNewChat={handleNewChat}
            isLoading={isRobinLoading}
          />
        )
    }
  }

  const mobileTitle =
    activeView === 'agents'
      ? 'Agents'
      : activeView === 'activity'
        ? 'Activity'
        : activeView === 'settings'
          ? 'Settings'
          : activeView === 'dashboard' || activeView === 'overview'
            ? 'Dashboard'
            : 'Robin'

  return (
    // Desktop is the Figma "floating panels" composition: rounded cards with
    // gaps on a black canvas. Mobile stays full-bleed.
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-foreground md:gap-3 md:p-3">
      {/* Desktop sidebar */}
      <aside className="hidden w-44 shrink-0 overflow-hidden md:block md:rounded-3xl lg:w-60">
        <Sidebar
          activeView={activeView}
          onNavigate={handleNavigate}
          onSelectAgent={handleSelectAgent}
          selectedAgent={selectedAgent}
          history={history}
          activeConversationId={conversationIdRef.current}
          onLoadConversation={handleLoadConversation}
          onDeleteConversation={handleDeleteConversation}
        />
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4 md:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="-ml-1 flex size-9 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <Menu className="size-5" strokeWidth={1.75} />
          </button>
          <span className="font-sans text-base font-semibold tracking-tight text-foreground">Nock</span>
          <span className="ml-auto text-sm text-muted-foreground">
            {mobileTitle}
          </span>
        </header>

        {/* Desktop main */}
        <main className="hidden min-h-0 flex-1 md:flex">
          {renderDesktopMain()}
        </main>

        {/* Mobile main */}
        <main className="min-h-0 flex-1 md:hidden">{renderMobileMain()}</main>

        {/* Mobile bottom nav */}
        <BottomNav active={activeView} onChange={handleNavigate} />
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-background/70 backdrop-blur-sm"
          />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[80%] border-r border-border shadow-xl">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close menu"
              className="absolute right-3 top-4 z-10 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" strokeWidth={1.75} />
            </button>
            <Sidebar
              activeView={activeView}
              onNavigate={handleNavigate}
              onSelectAgent={handleSelectAgent}
              selectedAgent={selectedAgent}
              history={history}
              activeConversationId={conversationIdRef.current}
              onLoadConversation={handleLoadConversation}
              onDeleteConversation={handleDeleteConversation}
            />
          </div>
        </div>
      )}
    </div>
  )
}
