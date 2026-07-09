import { Coins, TrendingUp, ArrowLeftRight, LineChart, Vault } from 'lucide-react'
import type { AgentId } from './data'

const map = {
  yield: Coins,
  perps: TrendingUp,
  swap: ArrowLeftRight,
  stock: LineChart,
  vault: Vault,
} as const

export function AgentIcon({
  agent,
  className,
}: {
  agent: AgentId
  className?: string
}) {
  const Icon = map[agent]
  return <Icon className={className} strokeWidth={1.75} aria-hidden="true" />
}
