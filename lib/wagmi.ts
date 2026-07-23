import { createConfig } from '@privy-io/wagmi'
import { http } from 'wagmi'
import { mainnet, base } from 'viem/chains'
import { nockChain } from './chain'

// mainnet + base are registered alongside Robinhood Chain so the Houdini cross-chain
// funding flow can switch the wallet to the SELL chain and sign there (see the
// routeVia:'houdini' branch in nock-app.tsx) — Privy/wagmi reject switchChain to any
// chain not listed here.
export const wagmiConfig = createConfig({
  chains: [nockChain, mainnet, base],
  transports: {
    [nockChain.id]: http(),
    [mainnet.id]: http(),
    [base.id]: http(),
  },
})
