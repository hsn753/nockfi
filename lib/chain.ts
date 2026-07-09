import { defineChain } from 'viem'

// Public, keyless RPC for the browser-side chain definition (rate-limited but fine
// for wallet connectivity). All balance reads use the keyed server-side RPC_URL.
const PUBLIC_RPC = 'https://rpc.testnet.chain.robinhood.com'

const CHAIN_ID = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID!, 10)
const BLOCK_EXPLORER_URL = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL!

export const nockChain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [PUBLIC_RPC] },
  },
  blockExplorers: {
    default: { name: 'Explorer', url: BLOCK_EXPLORER_URL },
  },
})
