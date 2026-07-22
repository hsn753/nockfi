import { type WalletClient } from 'viem'

// EIP-5792 atomic batching.
//
// A normal wallet account (EOA) signs each transaction separately, so a first-ever
// trade of a token is two prompts: approve, then swap. That's a blockchain rule, not
// something the app adds. The ONLY way to collapse them into a single confirmation is a
// wallet running as a "smart account" (a smart-contract wallet, or an EOA upgraded via
// EIP-7702) that can execute several calls atomically in one user approval.
//
// These helpers probe for that capability and, when present, send [approve…, swap] as
// one bundle. Callers fall back to their existing sequential flow when it's absent, so
// standard wallets behave exactly as before.

export type BatchCall = { to: `0x${string}`; data?: `0x${string}`; value?: bigint }

// True only when the connected wallet advertises atomic batching for this chain. Any
// wallet that doesn't implement wallet_getCapabilities (most standard EOAs) throws here
// and is treated as unsupported — the caller then does the normal one-tx-at-a-time flow.
export async function supportsAtomicBatch(
  walletClient: WalletClient,
  account: `0x${string}`,
  chainId: number,
): Promise<boolean> {
  try {
    const caps = (await (walletClient as any).getCapabilities({ account, chainId })) as any
    // The chain-scoped result may be returned directly or keyed by chainId, depending on
    // the wallet — accept either shape.
    const scoped = caps?.atomic || caps?.atomicBatch ? caps : caps?.[chainId]
    const atomic = scoped?.atomic ?? scoped?.atomicBatch
    const status = atomic?.status
    // 'supported' = batches now; 'ready' = will after a one-time account upgrade prompt.
    return status === 'supported' || status === 'ready'
  } catch {
    return false
  }
}

// Sends the calls as ONE atomic bundle (all-or-nothing) and waits for it to land.
// Returns the on-chain tx hash — a single hash for an atomic smart-account bundle — or
// an error string if the bundle reverted. Only call after supportsAtomicBatch() is true.
export async function sendAtomicBatch(
  walletClient: WalletClient,
  params: { account: `0x${string}`; chain: unknown; calls: BatchCall[] },
): Promise<{ txHash?: `0x${string}`; error?: string }> {
  const sendRes = (await (walletClient as any).sendCalls({
    account: params.account,
    chain: params.chain,
    calls: params.calls,
    forceAtomic: true,
  })) as any
  const id = sendRes?.id ?? sendRes
  const res = (await (walletClient as any).waitForCallsStatus({ id, throwOnFailure: false })) as any
  const receipts = res?.receipts ?? []
  const txHash: `0x${string}` | undefined =
    receipts[receipts.length - 1]?.transactionHash ?? receipts[0]?.transactionHash
  if (res?.status !== 'success') {
    return {
      txHash,
      error:
        'Transaction reverted on-chain — nothing was swapped (funds are safe, only gas was spent). This usually means the quote went stale between preview and signing. Try again for a fresh quote.',
    }
  }
  return { txHash }
}
