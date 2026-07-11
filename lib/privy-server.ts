import { PrivyClient } from '@privy-io/node'
import { createViemAccount } from '@privy-io/node/viem'
import { createWalletClient, http, type Hash } from 'viem'
import { nockChain } from './chain'

let client: PrivyClient | null = null

function getPrivyClient(): PrivyClient {
  if (!client) {
    const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID
    const appSecret = process.env.PRIVY_APP_SECRET
    if (!appId || !appSecret) throw new Error('NEXT_PUBLIC_PRIVY_APP_ID or PRIVY_APP_SECRET not configured')
    client = new PrivyClient({ appId, appSecret })
  }
  return client
}

// Only present once "Require signed requests" is enabled in the Privy dashboard.
// Without it, delegated actions still work — this just adds a second layer of
// request-signing security on top of the app secret.
function getAuthorizationContext() {
  const key = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY
  return key ? { authorization_private_keys: [key] } : undefined
}

export type DelegatedTxParams = {
  to: `0x${string}`
  data: `0x${string}`
  value: bigint
  gas: bigint
}

// Executes a transaction on a wallet the user has delegated to this app via Privy
// session signers — no wallet popup, no mobile approval round trip. Requires
// "Server-side access" to be enabled for this app in the Privy dashboard, and the
// wallet to have actually been delegated by the user first (see useDelegatedActions
// on the client).
export async function executeDelegatedTransaction(
  walletId: string,
  address: `0x${string}`,
  transaction: DelegatedTxParams,
): Promise<{ txHash: Hash; error?: string }> {
  const privy = getPrivyClient()
  const account = createViemAccount(privy, {
    walletId,
    address,
    authorizationContext: getAuthorizationContext(),
  })

  const walletClient = createWalletClient({
    account,
    chain: nockChain,
    transport: http(process.env.RPC_URL),
  })

  try {
    const txHash = await walletClient.sendTransaction({
      account,
      chain: nockChain,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      gas: transaction.gas,
    })

    const publicClient = (await import('viem')).createPublicClient({
      chain: nockChain,
      transport: http(process.env.RPC_URL),
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      return {
        txHash,
        error: 'Transaction reverted on-chain — nothing was swapped (funds are safe, only gas was spent). This usually means the quote went stale. Try again for a fresh quote.',
      }
    }

    return { txHash }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { txHash: '0x' as Hash, error: message }
  }
}
