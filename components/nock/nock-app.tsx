'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWallets, usePrivy } from '@privy-io/react-auth'
import { useWalletClient, usePublicClient } from 'wagmi'
import { erc20Abi, formatUnits, parseUnits } from 'viem'
import { Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  localChatStorage,
  type ConversationSummary,
} from '@/lib/chat-storage'
import { executeSwap } from '@/lib/execute-swap'
import { SWAP_TOKENS } from '@/lib/get-swap-quote'
import { startBridgeWatch, getPendingBridge, clearBridgeWatch, type PendingBridge } from '@/lib/bridge-tracker'
import {
  getAgent,
  initialActivity,
  initialAttention,
  initialMessages,
  initialPositions,
  type ActionPreview,
  type ActivityItem,
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
  const { user: privyUser } = usePrivy()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()

  // Once a user delegates an embedded "instant swap" wallet (see Settings), that
  // wallet becomes the one Nock reads balances from and executes swaps against —
  // it's the wallet that will actually hold funds and sign without a mobile prompt.
  // Otherwise, fall back to whatever external wallet is connected.
  const delegatedWallet = useMemo(() => {
    const match = privyUser?.linkedAccounts?.find(
      (a: any) => a.type === 'wallet' && a.walletClientType === 'privy' && a.chainType === 'ethereum' && a.delegated,
    ) as { address: string; id?: string } | undefined
    return match
  }, [privyUser])

  const walletAddress = delegatedWallet?.address || wallets[0]?.address

  // Debug logging
  useEffect(() => {
    console.log('[Nock] Wallets detected:', wallets)
    console.log('[Nock] Wallet address:', walletAddress)
  }, [wallets, walletAddress])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isRobinLoading, setIsRobinLoading] = useState(false)
  const [attention, setAttention] = useState<AttentionItem[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [activity, setActivity] = useState<ActivityItem[]>([])
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

      const total = (data.balances || []).reduce(
        (sum: number, b: { usdValue?: number | null }) => sum + (b.usdValue ?? 0),
        0,
      )
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

  const handleSend = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = { id: `${Date.now()}-u`, role: 'user', text }
      setMessages((prev) => [...prev, userMsg])
      setIsRobinLoading(true)

      try {
        const history: ChatMessage[] = [
          ...messages.filter((m) => !DEMO_IDS.has(m.id)),
          userMsg,
        ]

        console.log('[Nock] Sending to API - wallet address:', walletAddress)

        const res = await fetch('/api/robin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages],
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

    // REAL SWAP EXECUTION - NO MOCK DATA
    if (action.agent === 'swap' && (walletClient || delegatedWallet)) {
      try {
        // Extract transaction data from action
        // The transaction data is stored in the action from the swap quote
        const txData = (action as any).transactionData
        const fromToken = ((action as any).fromToken || 'USDG') as string
        const fromAmount = (action as any).amount || '0'

        if (!txData) {
          throw new Error('No transaction data in action')
        }

        // Pre-flight balance check — without this, a wallet that can't cover the
        // transaction tends to hang and time out instead of failing cleanly, which
        // reads as a broken app rather than "you don't have enough funds."
        if (publicClient && walletAddress) {
          const tokenInfo = SWAP_TOKENS[fromToken.toUpperCase()]
          const isNativeEth = fromToken.toUpperCase() === 'ETH'
          const requiredAmount = tokenInfo ? parseUnits(fromAmount, tokenInfo.decimals) : BigInt(0)
          const ethBalance = await publicClient.getBalance({ address: walletAddress as `0x${string}` })
          const gasCost = BigInt(txData.gas || '0') * BigInt(txData.gasPrice || '0')

          if (isNativeEth) {
            const totalNeeded = requiredAmount + gasCost
            if (ethBalance < totalNeeded) {
              throw new Error(
                `Not enough ETH. You need about ${formatUnits(totalNeeded, 18)} ETH (swap amount + gas) but this wallet has ${formatUnits(ethBalance, 18)} ETH on Robinhood Chain. Bridge more ETH in first.`,
              )
            }
          } else if (tokenInfo) {
            const tokenBalance = await publicClient.readContract({
              address: tokenInfo.address as `0x${string}`,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [walletAddress as `0x${string}`],
            })
            if (tokenBalance < requiredAmount) {
              throw new Error(
                `Not enough ${fromToken}. You need ${fromAmount} ${fromToken} but this wallet has ${formatUnits(tokenBalance, tokenInfo.decimals)} ${fromToken} on Robinhood Chain.`,
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

        console.log('Executing real swap transaction...')
        const result = delegatedWallet
          ? await (async () => {
              const res = await fetch('/api/execute-delegated-swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ walletId: (delegatedWallet as any).id, address: delegatedWallet.address, transaction: txData }),
              })
              const data = await res.json()
              return { txHash: data.txHash as `0x${string}` | undefined, error: data.error as string | undefined }
            })()
          : await executeSwap({
              walletClient: walletClient!,
              publicClient,
              fromToken: (action as any).fromToken || 'USDG',
              toToken: (action as any).toToken || 'TSLA',
              amount: (action as any).amount || '0',
              transaction: txData,
            })

        if (result.error) {
          const hashSuffix = result.txHash && result.txHash !== '0x' ? ` (tx: ${result.txHash.slice(0, 10)}...${result.txHash.slice(-8)})` : ''
          throw new Error(`${result.error}${hashSuffix}`)
        }

        console.log('Swap executed! TX Hash:', result.txHash)

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
            text: `Done! Swap executed on Robinhood Chain. TX: ${result.txHash ? `${result.txHash.slice(0, 10)}...${result.txHash.slice(-8)}` : 'confirmed'}`,
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
          const newActivity: ActivityItem = {
            id: `act-log-${actionId}`,
            agent: action.agent,
            title: action.outcome.activityTitle,
            detail: action.detail,
            time: 'Just now',
            amount: action.outcome.activityAmount,
          }

          setPositions((p) =>
            p.some((x) => x.id === newPosition.id) ? p : [newPosition, ...p],
          )
          setActivity((a) =>
            a.some((x) => x.id === newActivity.id) ? a : [newActivity, ...a],
          )
          setAttention((att) => att.filter((x) => x.agent !== action.agent))
          setAddedValue(
            (v) =>
              v + parseFloat(action.outcome.value.replace(/[^0-9.]/g, '') || '0'),
          )

          return [...updated, confirm]
        })
      } catch (error) {
        console.error('Swap execution failed:', error)
        const rawMessage = error instanceof Error ? error.message : 'Unknown error'
        const isTimeout = /timeout/i.test(rawMessage)
        const friendlyMessage = isTimeout
          ? "Your wallet didn't respond in time. This usually means a connected mobile wallet (like the Robinhood app over WalletConnect) either missed the approval notification or the session went stale. Check your phone for a pending approval, or try disconnecting and reconnecting your wallet, then attempt the swap again."
          : `Swap failed: ${rawMessage}. Please try again.`
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
    } else if (!walletClient) {
      // No wallet connected
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
          const newActivity: ActivityItem = {
            id: `act-log-${actionId}`,
            agent: action.agent,
            title: action.outcome.activityTitle,
            detail: action.detail,
            time: 'Just now',
            amount: action.outcome.activityAmount,
          }

          setPositions((p) =>
            p.some((x) => x.id === newPosition.id) ? p : [newPosition, ...p],
          )
          setActivity((a) =>
            a.some((x) => x.id === newActivity.id) ? a : [newActivity, ...a],
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
  }, [messages, walletClient])

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
        />
      )
    }
    if (activeView === 'activity') {
      return <ActivityView activity={activity} />
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
            activity={activity}
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
          />
        )
      case 'activity':
        return <ActivityView activity={activity} />
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
            activity={activity}
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
