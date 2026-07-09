import { defineChain } from 'viem'

const PUBLIC_RPC = process.env.NEXT_PUBLIC_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const CHAIN_ID = 4663
const BLOCK_EXPLORER_URL = 'https://robinhoodchain.blockscout.com'

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [PUBLIC_RPC] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: BLOCK_EXPLORER_URL },
  },
})

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
})

export const nockChain = robinhoodChain
