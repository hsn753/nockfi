import type { PublicClient } from 'viem'

// The single definition of what gas price a transaction is sent with: the
// HIGHER of the quote-time price (already carries 2x headroom) and a fresh
// 2x-headroom read at send time. A card can sit minutes between quote and
// confirm; a quote-time price below the current base fee gets rejected with a
// fee-cap error (the yield agent hit exactly this in prod). Every executor AND
// the client's ETH-for-gas pre-flight must use this same function — when the
// pre-flight priced gas differently from the send, a passing check could still
// be followed by a raw insufficient-funds wallet error.
export async function resolveSendGasPrice(publicClient: PublicClient, quotedGasPrice: string | undefined): Promise<bigint> {
  const fresh = (await publicClient.getGasPrice()) * BigInt(2)
  const quoted = BigInt(quotedGasPrice || '0')
  return quoted > fresh ? quoted : fresh
}
