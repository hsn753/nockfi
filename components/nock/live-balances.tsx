'use client'

import { useState, useEffect } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { Loader2 } from 'lucide-react'

type BalanceEntry = {
  symbol: string
  name: string
  amount: string
  usdValue?: number | null
}

export function LiveBalances() {
  const { ready, authenticated } = usePrivy()
  const { wallets } = useWallets()
  const address = wallets[0]?.address

  const [balances, setBalances] = useState<BalanceEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState(false)

  useEffect(() => {
    if (!ready || !authenticated || !address) {
      setBalances(null)
      setFetchError(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setFetchError(false)

    fetch(`/api/balances?address=${encodeURIComponent(address)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ balances: BalanceEntry[] }>
      })
      .then(({ balances: data }) => {
        if (!cancelled) setBalances(data)
      })
      .catch(() => {
        if (!cancelled) setFetchError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [ready, authenticated, address])

  if (!ready || !authenticated || !address) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
        <p className="text-sm font-medium text-foreground">No wallet connected</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Connect a wallet to see your live on-chain balances.
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (fetchError || !balances) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
        <p className="text-sm font-medium text-foreground">Could not load balances</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Check your connection and try refreshing.
        </p>
      </div>
    )
  }

  if (balances.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
        <p className="text-sm font-medium text-foreground">No balances yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Tokens you hold on Robinhood Chain will show up here.
        </p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col gap-1 p-4">
      {balances.map((b) => (
        <BalanceRow key={b.symbol} symbol={b.symbol} name={b.name} amount={b.amount} usdValue={b.usdValue} />
      ))}
    </ul>
  )
}

function BalanceRow({
  symbol,
  name,
  amount,
  usdValue,
}: {
  symbol: string
  name: string
  amount: string
  usdValue?: number | null
}) {
  return (
    <li className="flex items-center gap-3 rounded-xl px-3 py-3.5 hover:bg-background/40">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary font-mono text-xs font-semibold text-foreground">
        {symbol.slice(0, 4)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{symbol}</p>
        <p className="truncate text-xs text-muted-foreground">{name}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold text-foreground">{amount}</p>
        <p className="text-xs text-muted-foreground">
          {usdValue != null
            ? `$${usdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : 'Price unavailable'}
        </p>
      </div>
    </li>
  )
}
