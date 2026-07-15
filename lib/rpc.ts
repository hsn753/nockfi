import { createPublicClient, http, fallback } from 'viem'
import { nockChain } from './chain'

const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'

// One shared read client for server-side on-chain reads, with retry + automatic fallback.
// Under load a single Alchemy key 429s ("Rate Limit Hit"); viem's fallback transport then
// rotates to the public Robinhood RPC, and retryCount smooths transient rate limits — so a
// 429 storm no longer takes down balances, yield, and collateral reads all at once (the
// original setup was a bare http(RPC_URL) with no retry/fallback anywhere). Singleton, so
// hot paths stop rebuilding a client per request; the chain's multicall3 config still
// applies for batching.
let readClient: ReturnType<typeof createPublicClient> | null = null

export function getReadClient() {
  if (!readClient) {
    const primary = process.env.RPC_URL
    const transports =
      primary && primary !== PUBLIC_RPC
        ? [http(primary, { retryCount: 2, retryDelay: 200 }), http(PUBLIC_RPC, { retryCount: 2, retryDelay: 300 })]
        : [http(PUBLIC_RPC, { retryCount: 3, retryDelay: 250 })]
    readClient = createPublicClient({ chain: nockChain, transport: fallback(transports) })
  }
  return readClient
}
