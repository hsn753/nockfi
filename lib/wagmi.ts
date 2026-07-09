import { createConfig } from '@privy-io/wagmi'
import { http } from 'wagmi'
import { nockChain } from './chain'

export const wagmiConfig = createConfig({
  chains: [nockChain],
  transports: {
    [nockChain.id]: http(),
  },
})
