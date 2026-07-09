export type NavView =
  | 'overview'
  | 'chat'
  | 'agents'
  | 'activity'
  | 'settings'
  | 'dashboard'

export type AgentId = 'yield' | 'perps' | 'swap' | 'stock' | 'vault'

export type Agent = {
  id: AgentId
  name: string
  tagline: string
  description: string
  capabilities: string[]
  gated: boolean
  status: 'active' | 'available'
}

export const agents: Agent[] = [
  {
    id: 'yield',
    name: 'Yield agent',
    tagline: 'Earn on idle stablecoins across vetted lending markets.',
    description:
      'The yield agent scans vetted lending markets and stablecoin strategies, then routes your idle balances to the best risk-adjusted rate. It monitors positions continuously and flags you when a better route opens up.',
    capabilities: [
      'Route idle stablecoins to the best available rate',
      'Continuously monitor for better opportunities',
      'Auto-compound rewards on a schedule you set',
    ],
    gated: false,
    status: 'active',
  },
  {
    id: 'perps',
    name: 'Perps agent',
    tagline: 'Trade perpetual futures with managed risk.',
    description:
      'The perps agent opens and manages perpetual futures positions with built-in risk guards. It sizes positions against your collateral, sets liquidation buffers, and can trail stops as a trade moves in your favor.',
    capabilities: [
      'Size positions against available collateral',
      'Maintain liquidation buffers automatically',
      'Trail stops and take profit on your rules',
    ],
    gated: true,
    status: 'available',
  },
  {
    id: 'swap',
    name: 'Swap agent',
    tagline: 'Swap tokens at the best route with low slippage.',
    description:
      'The swap agent splits orders across liquidity sources to find the best execution. It previews price impact before you confirm and protects every trade against slippage and sandwich attacks.',
    capabilities: [
      'Split orders for best execution',
      'Preview price impact before confirming',
      'Protect trades from slippage and MEV',
    ],
    gated: false,
    status: 'active',
  },
  {
    id: 'stock',
    name: 'Stock token agent',
    tagline: 'Trade tokenized equities around the clock.',
    description:
      'The stock token agent lets you buy and sell tokenized equities like AAPL and TSLA at any hour. It tracks reference prices, manages fractional sizing, and handles token dividends as they accrue.',
    capabilities: [
      'Buy and sell tokenized equities 24/7',
      'Track reference prices and fractional sizing',
      'Claim and reinvest token dividends',
    ],
    gated: true,
    status: 'available',
  },
  {
    id: 'vault',
    name: 'Vault agent',
    tagline: 'Automated multi-strategy vaults that rebalance for you.',
    description:
      'The vault agent allocates across multiple strategies and rebalances as conditions change. Set a target risk level and the agent handles entries, exits, and harvesting so your capital stays productive.',
    capabilities: [
      'Allocate across multiple strategies',
      'Rebalance automatically as markets move',
      'Harvest and reinvest without manual steps',
    ],
    gated: true,
    status: 'available',
  },
]

export function getAgent(id: AgentId): Agent {
  return agents.find((a) => a.id === id) as Agent
}

export type ActionPreview = {
  id: string
  agent: AgentId
  action: string
  detail: string
  metrics: { label: string; value: string; positive?: boolean }[]
  status: 'pending' | 'confirming' | 'executed' | 'reviewing'
  // Used to build the resulting active position and activity row on loose.
  outcome: {
    title: string
    value: string
    meta: string
    activityTitle: string
    activityAmount?: string
  }
}

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'robin'; text: string; action?: ActionPreview }

export type Position = {
  id: string
  agent: AgentId
  title: string
  subtitle: string
  value: string
  meta: string
  metaPositive?: boolean
}

export type AttentionItem = {
  id: string
  agent: AgentId
  title: string
  subtitle: string
  meta: string
}

export type ActivityItem = {
  id: string
  agent: AgentId
  title: string
  detail: string
  time: string
  amount?: string
}

export type Balance = {
  symbol: string
  name: string
  amount: string
  usd: string
  change: string
  positive: boolean
}

export const initialMessages: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    text: 'Put my idle USDC to work.',
  },
  {
    id: 'm2',
    role: 'robin',
    text: "You have 12,400 USDC sitting idle. I'll route this to the yield agent for a lending position on Marlin, currently the best risk-adjusted rate. Review the preview and confirm when you're ready.",
    action: {
      id: 'act-1',
      agent: 'yield',
      action: 'Lend 12,400 USDC on Marlin',
      detail: 'Supply-side lending, withdraw anytime, no lockup.',
      metrics: [
        { label: 'Estimated APY', value: '7.02%', positive: true },
        { label: 'Projected yearly', value: '+$870', positive: true },
        { label: 'Lockup', value: 'None' },
      ],
      status: 'pending',
      outcome: {
        title: 'USDC lending',
        value: '$12,400.00',
        meta: '7.02% APY',
        activityTitle: 'Lent 12,400 USDC on Marlin',
        activityAmount: '12,400 USDC',
      },
    },
  },
]

export const initialAttention: AttentionItem[] = [
  {
    id: 'at-1',
    agent: 'stock',
    title: 'AAPL token dividend claimable',
    subtitle: 'Stock token agent · quarterly distribution',
    meta: '+$4.20',
  },
  {
    id: 'at-2',
    agent: 'vault',
    title: 'Vault drift above target',
    subtitle: 'Vault agent · balanced strategy is 6% off target',
    meta: 'Rebalance',
  },
]

export const initialPositions: Position[] = [
  {
    id: 'p-1',
    agent: 'vault',
    title: 'Balanced vault',
    subtitle: 'Vault agent · multi-strategy',
    value: '$18,240.00',
    meta: '+5.1% APY',
    metaPositive: true,
  },
  {
    id: 'p-2',
    agent: 'swap',
    title: 'ETH position',
    subtitle: 'Swap agent · spot',
    value: '$11,405.00',
    meta: '+2.8% today',
    metaPositive: true,
  },
]

export const initialActivity: ActivityItem[] = [
  {
    id: 'ac-1',
    agent: 'swap',
    title: 'Swapped USDG for ETH',
    detail: 'Best route across 3 pools · 0.04% price impact',
    time: '2h ago',
    amount: '3,000 USDG',
  },
  {
    id: 'ac-2',
    agent: 'vault',
    title: 'Balanced vault rebalanced',
    detail: 'Shifted 4% from ETH into stablecoin sleeve',
    time: 'Yesterday',
  },
  {
    id: 'ac-3',
    agent: 'stock',
    title: 'Bought AAPL stock token',
    detail: '15 tokens at $221.40 reference price',
    time: '3d ago',
    amount: '$3,321.00',
  },
]

export const balances: Balance[] = [
  {
    symbol: 'USDC',
    name: 'USD Coin',
    amount: '12,400.00',
    usd: '$12,400.00',
    change: '0.0%',
    positive: true,
  },
  {
    symbol: 'USDG',
    name: 'Global Dollar',
    amount: '8,250.50',
    usd: '$8,250.50',
    change: '0.0%',
    positive: true,
  },
  {
    symbol: 'ETH',
    name: 'Ethereum',
    amount: '3.42',
    usd: '$11,405.00',
    change: '+2.8%',
    positive: true,
  },
  {
    symbol: 'AAPL',
    name: 'Apple stock token',
    amount: '15.00',
    usd: '$3,321.00',
    change: '-0.6%',
    positive: false,
  },
  {
    symbol: 'NOCK',
    name: 'Nock',
    amount: '5,200.00',
    usd: '$2,860.00',
    change: '+11.4%',
    positive: true,
  },
]

export function buildRobinReply(text: string, id: string): ChatMessage {
  const t = text.toLowerCase()

  if (t.includes('swap') || t.includes('buy eth') || t.includes('eth')) {
    return {
      id,
      role: 'robin',
      text: 'I can route that through the swap agent. Here is the best execution I found across current liquidity. Review it and loose when you are ready.',
      action: {
        id: `act-${id}`,
        agent: 'swap',
        action: 'Swap 3,000 USDG for ETH',
        detail: 'Split across 3 pools for best execution, MEV protected.',
        metrics: [
          { label: 'You receive', value: '0.90 ETH', positive: true },
          { label: 'Price impact', value: '0.05%' },
          { label: 'Est. fee', value: '$1.80' },
        ],
        status: 'pending',
        outcome: {
          title: 'ETH position',
          value: '$3,000.00',
          meta: 'Swap filled',
          activityTitle: 'Swapped 3,000 USDG for ETH',
          activityAmount: '0.90 ETH',
        },
      },
    }
  }

  if (t.includes('aapl') || t.includes('stock') || t.includes('apple')) {
    return {
      id,
      role: 'robin',
      text: 'The stock token agent can handle that. Tokenized AAPL trades around the clock. Here is the preview for your review.',
      action: {
        id: `act-${id}`,
        agent: 'stock',
        action: 'Buy 5 AAPL stock token',
        detail: 'Tokenized equity, fractional sizing, 24/7 market.',
        metrics: [
          { label: 'Reference price', value: '$221.40' },
          { label: 'Total', value: '$1,107.00' },
          { label: 'Requires', value: '$NOCK' },
        ],
        status: 'pending',
        outcome: {
          title: 'AAPL stock token',
          value: '$1,107.00',
          meta: 'Long',
          activityTitle: 'Bought 5 AAPL stock token',
          activityAmount: '$1,107.00',
        },
      },
    }
  }

  if (t.includes('vault') || t.includes('rebalance')) {
    return {
      id,
      role: 'robin',
      text: 'I will hand this to the vault agent. It allocates across strategies and rebalances for you. Preview below.',
      action: {
        id: `act-${id}`,
        agent: 'vault',
        action: 'Deposit 5,000 USDG into balanced vault',
        detail: 'Multi-strategy allocation, auto-rebalanced, no lockup.',
        metrics: [
          { label: 'Target APY', value: '5.10%', positive: true },
          { label: 'Risk', value: 'Balanced' },
          { label: 'Requires', value: '$NOCK' },
        ],
        status: 'pending',
        outcome: {
          title: 'Balanced vault deposit',
          value: '$5,000.00',
          meta: '5.10% APY',
          activityTitle: 'Deposited 5,000 USDG into balanced vault',
          activityAmount: '5,000 USDG',
        },
      },
    }
  }

  if (
    t.includes('usdc') ||
    t.includes('idle') ||
    t.includes('yield') ||
    t.includes('earn') ||
    t.includes('work')
  ) {
    return {
      id,
      role: 'robin',
      text: 'I can put that to work through the yield agent. Here is the best risk-adjusted lending route right now. Review and loose to confirm.',
      action: {
        id: `act-${id}`,
        agent: 'yield',
        action: 'Lend 5,000 USDC on Marlin',
        detail: 'Supply-side lending, withdraw anytime, no lockup.',
        metrics: [
          { label: 'Estimated APY', value: '7.02%', positive: true },
          { label: 'Projected yearly', value: '+$351', positive: true },
          { label: 'Lockup', value: 'None' },
        ],
        status: 'pending',
        outcome: {
          title: 'USDC lending',
          value: '$5,000.00',
          meta: '7.02% APY',
          activityTitle: 'Lent 5,000 USDC on Marlin',
          activityAmount: '5,000 USDC',
        },
      },
    }
  }

  return {
    id,
    role: 'robin',
    text: 'Got it. I can route that to one of your agents. Try asking me to put idle USDC to work, swap into ETH, buy an AAPL stock token, or deposit into a vault, and I will prepare an action for you to review.',
  }
}

export const user = {
  address: '0x815A...1cB5',
  draws: '1,240',
  season: 'Season 1',
  seasonProgress: 62,
}
