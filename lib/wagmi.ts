import { createConfig } from '@privy-io/wagmi'
import { http } from 'wagmi'
import { mainnet, base, arbitrum, optimism, polygon } from 'viem/chains'
import { nockChain } from './chain'

// These are registered alongside Robinhood Chain so the Houdini flows can switch the
// wallet to the SELL chain and sign there (see the routeVia:'houdini' and
// 'houdini-private' branches in nock-app.tsx) — Privy/wagmi reject switchChain to any
// chain not listed here. Only the chain a user SIGNS on needs to be here; a private
// send can DELIVER to any of Houdini's ~100 chains, which needs no local signing.
export const wagmiConfig = createConfig({
  chains: [nockChain, mainnet, base, arbitrum, optimism, polygon],
  transports: {
    [nockChain.id]: http(),
    [mainnet.id]: http(),
    [base.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
  },
})
