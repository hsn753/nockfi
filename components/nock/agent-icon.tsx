import { Coins, CandlestickChart, ArrowLeftRight, SquareActivity, SquareX } from 'lucide-react'
import type { AgentId } from './data'

// Icon set matched to the Figma sidebar: candlesticks for Perps, chart-square
// for Tokenized Stocks, X-square for Vault.
const map = {
  yield: Coins,
  perps: CandlestickChart,
  swap: ArrowLeftRight,
  stock: SquareActivity,
  vault: SquareX,
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
