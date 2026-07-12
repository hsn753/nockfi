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
    tagline: 'Trade tokenized stocks, live around the clock.',
    description:
      "The stock token agent trades Robinhood's official tokenized equities (AAPL, TSLA, NVDA, SPY and more) on-chain, 24/7, routed directly through Uniswap. Every token is verified against Robinhood's official deployer before it's ever quoted, so impersonator contracts can't reach you. A stock token gives you price exposure, not share ownership — no dividends, no voting rights.",
    capabilities: [
      'Buy and sell official tokenized stocks around the clock',
      'Verify every contract against the official issuer before quoting',
      'Live on-chain prices from real trading, never estimates',
    ],
    gated: false,
    status: 'active',
  },
  {
    id: 'vault',
    name: 'Vault agent',
    tagline: 'Sets and enforces your guardrails on every action.',
    description:
      'The vault agent sets and enforces the guardrails behind every request: a spend limit you control, and automatic protections against fabricated numbers or mismatched tokens. It works quietly in the background on every single action the other agents take, and never moves money itself.',
    capabilities: [
      'Enforce a spend limit you set, before any action is even proposed',
      'Block fabricated prices, amounts, or token substitutions automatically',
      'Show your current guardrails in plain language, not just claim they exist',
    ],
    gated: false,
    status: 'active',
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
  // Used to build the resulting active position and activity row once confirmed.
  outcome: {
    title: string
    value: string
    meta: string
    activityTitle: string
    activityAmount?: string
  }
}

export type BridgeInfo = {
  link: string
  sourceChain: string
  destinationChain: string
  etaMinutes: number
}

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'robin'; text: string; action?: ActionPreview; bridgeInfo?: BridgeInfo }

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

export const initialMessages: ChatMessage[] = []

export const initialAttention: AttentionItem[] = [
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


export const user = {
  address: '0x815A...1cB5',
  draws: '1,240',
  season: 'Season 1',
  seasonProgress: 62,
}
