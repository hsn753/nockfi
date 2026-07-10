'use client'

import { ArrowUpRight } from 'lucide-react'
import type { BridgeInfo } from './data'

export function BridgeInfoCard({ bridgeInfo }: { bridgeInfo: BridgeInfo }) {
  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-border/70 bg-card">
      <div className="px-5 pt-5">
        <p className="text-[15px] font-semibold leading-snug text-foreground">
          Bridge {bridgeInfo.sourceChain} to Robinhood Chain
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          Official Arbitrum bridge. Deposits typically confirm in about {bridgeInfo.etaMinutes} minutes.
        </p>
      </div>
      <div className="px-5 pb-5 pt-4">
        <a
          href={bridgeInfo.link}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-1.5 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Open bridge
          <ArrowUpRight className="size-4" strokeWidth={2} />
        </a>
      </div>
    </div>
  )
}
