'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWallets, usePrivy, getIdentityToken } from '@privy-io/react-auth'
import { usePublicClient } from 'wagmi'
import { erc20Abi, formatUnits, parseUnits, createWalletClient, custom } from 'viem'
import { Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils'
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
import { Sidebar } from './sidebar'
import { ChatPanel } from './chat-panel'
import { DashboardPanel } from './dashboard-panel'
import { AgentsView } from './agents-view'
import { ActivityView } from './activity-view'
import { SettingsView } from './settings-view'
import { BottomNav } from './bottom-nav'

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
  const { user: privyUser, ready: privyReady } = usePrivy()
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
  const [pendingBridge, setPendingBridge] = useState<PendingBridge | null>(null)

  const fetchPortfolioValue = useCallback(async (): Promise<number | null> => {
    if (!walletAddress) return null
    try {
      console.log('[Nock] Fetching balances for portfolio value...')
      const res = await fetch(`/api/balances?address=${walletAddress}`)

      if (!res.ok) {
        console.error('[Nock] Balance fetch failed:', res.status)
        return null
      }

      const data = await res.json()
      console.log('[Nock] Balances received:', data.balances)

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
      const total = walletTotal + netCollateral

      setPositions((prev) => {
        const withoutLoans = prev.filter((p) => !p.id.startsWith('loan-'))
        const loanCards: Position[] = loans.map((p) => ({
          id: `loan-${p.stockSymbol}`,
          agent: 'stock' as AgentId,
          title: `${p.stockSymbol} loan — ${p.collateralAmount} ${p.stockSymbol} posted`,
          subtitle: `Debt $${p.borrowedUsd.toFixed(2)} · liquidation at $${p.liquidationPriceUsd?.toFixed(2) ?? '—'}`,
          value: `$${(p.collateralValueUsd - p.borrowedUsd).toFixed(2)} net`,
          meta: `${p.ltvUtilizationPct.toFixed(0)}% of liquidation ceiling`,
          metaPositive: p.ltvUtilizationPct < 80,
        }))
        return [...loanCards, ...withoutLoans]
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
            subtitle: `Debt is at ${p.ltvUtilizationPct.toFixed(0)}% of the ceiling — liquidation if ${p.stockSymbol} falls to $${p.liquidationPriceUsd?.toFixed(2) ?? '—'}. Repay some debt or post more collateral.`,
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
            text: `Your bridged funds have arrived on Robinhood Chain — your balance went from about $${pendingBridge.snapshotUsd.toFixed(2)} to $${total.toFixed(2)}. Ready to put it to work whenever you are.`,
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
            text: "Still finishing loading your wallet — give it a second and try that again.",
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
        const identityToken = await getIdentityToken()

        const res = await fetch('/api/robin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Privy-Identity-Token': identityToken ?? '' },
          body: JSON.stringify({ messages: history, walletAddress }),
        })

        const { text: replyText, action, bridgeInfo } = (await res.json()) as {
          text: string
          action?: ActionPreview
          bridgeInfo?: { link: string; sourceChain: string; destinationChain: string; etaMinutes: number }
        }

        const replyMsg: ChatMessage = {
          id: `${Date.now()}-r`,
          role: 'robin',
          text: replyText,
          ...(action ? { action } : {}),
          ...(bridgeInfo ? { bridgeInfo } : {}),
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
      return
    }

    // REAL SWAP/YIELD-DEPOSIT EXECUTION - NO MOCK DATA
    const isRealExecutionAgent = action.agent === 'swap' || action.agent === 'yield' || action.agent === 'stock'
    if (isRealExecutionAgent && (activeWallet || delegatedWallet)) {
      try {
        // Fetched fresh (not from the reactive useIdentityToken() hook, verified against prod
        // to not reliably reflect a usable token for an already-connected session) and
        // reused for both requests below.
        const identityToken = await getIdentityToken()

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
          throw new Error('Missing sell token details for this preview — ask for a fresh quote and try again.')
        }

        // Stock-trade quotes carry an on-chain deadline (15 min). Confirming a
        // stale card would broadcast a guaranteed revert — gas spent, confusing
        // "slippage" error (exactly how the first live TSLA buy failed). Refuse
        // BEFORE broadcasting, with the honest reason.
        const quoteDeadline = (action as any).quoteDeadline as number | undefined
        if (quoteDeadline && Math.floor(Date.now() / 1000) > quoteDeadline) {
          throw new Error(
            'This trade preview has expired — quotes are only valid for 15 minutes, and executing an expired one would fail on-chain and still cost gas. Nothing was sent. Ask for a fresh quote and confirm that one.',
          )
        }

        // The Privy session policy that constrains delegated (instant-swap) execution
        // only allows transactions to the 0x swap router — a Morpho lend/withdraw would
        // be rejected server-side by Privy. Decline honestly up front rather than
        // letting the user watch a doomed attempt. (Expanding the policy safely —
        // especially constraining the withdraw receiver — is its own follow-up.)
        if ((action.agent === 'yield' || (action as any).routeVia === 'uniswap-v4' || (action as any).routeVia === 'morpho-collateral') && isUsingDelegatedWallet) {
          throw new Error(
            'This action needs your connected external wallet — the instant-swap wallet is currently only authorized for 0x swaps. Connect your main wallet and try again.',
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
          throw new Error('Not connected to Robinhood Chain — refresh and try again.')
        }

        console.log(action.agent === 'yield' ? (isWithdrawal ? 'Executing real withdrawal transaction...' : 'Executing real deposit transaction...') : 'Executing real swap transaction...')
        const result = isUsingDelegatedWallet
          ? await (async () => {
              const res = await fetch('/api/execute-delegated-swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Privy-Identity-Token': identityToken ?? '' },
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
            headers: { 'Content-Type': 'application/json', 'X-Privy-Identity-Token': identityToken ?? '' },
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
          throw new Error(result.error || 'No transaction hash was returned — the swap may not have been broadcast. Check your holdings before retrying.')
        }
        const verifyRes = await fetch('/api/verify-tx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txHash: result.txHash }),
        })
        const verifyData = await verifyRes.json()
        if (!verifyData.found) {
          throw new Error(`Couldn't confirm this transaction on Robinhood Chain (tx: ${result.txHash.slice(0, 10)}...${result.txHash.slice(-8)}). It may never have actually broadcast, regardless of what the wallet reported — check your real holdings before assuming anything happened, rather than trusting a success or failure message alone.`)
        }
        if (verifyData.status !== 'success') {
          throw new Error(`Transaction reverted on-chain (tx: ${result.txHash.slice(0, 10)}...${result.txHash.slice(-8)}) — nothing was swapped, only gas was spent.`)
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
        const friendlyMessage = isTimeout
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
      return <ActivityView />
    }
    if (activeView === 'settings') {
      return <SettingsView />
    }
    // chat / overview / dashboard -> split
    return (
      <div className="flex h-full min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <ChatPanel
            messages={messages}
            onSend={handleSend}
            onDraw={handleDraw}
            onLoose={handleLoose}
            onNewChat={handleNewChat}
            isLoading={isRobinLoading}
          />
        </div>
        <div className="hidden w-72 shrink-0 border-l border-border md:block lg:w-80">
          <DashboardPanel
            tab={dashboardTab}
            onTabChange={setDashboardTab}
            attention={attention}
            positions={positions}
            portfolioValue={portfolioValue}
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
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="hidden w-44 shrink-0 border-r border-border md:block lg:w-60">
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
          <span className="text-base font-semibold tracking-tight">
            <span className="text-foreground">N</span>
            <span className="text-primary">ock</span>
          </span>
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
