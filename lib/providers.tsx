'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PrivyProvider } from '@privy-io/react-auth'
import { WagmiProvider } from '@privy-io/wagmi'
import { useState } from 'react'
import { mainnet, base } from 'viem/chains'
import { wagmiConfig } from './wagmi'
import { nockChain } from './chain'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID

  // Skip wallet providers if no app ID is configured (e.g. during CI builds).
  if (!appId) {
    return <>{children}</>
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          theme: 'dark',
          accentColor: '#5eead4',
        },
        defaultChain: nockChain as never,
        // mainnet + base are here (not just Robinhood Chain) so Privy allows the wallet to
        // switchChain to them during Houdini cross-chain funding — otherwise it throws
        // "Unsupported chainId" for any chain not in this list.
        supportedChains: [nockChain, mainnet, base] as never,
        embeddedWallets: {
          ethereum: { createOnLogin: 'users-without-wallets' },
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  )
}
