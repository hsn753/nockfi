// Turn a raw wallet/tx error into a short, human message. viem/wallet errors are huge
// multi-line dumps that include the full calldata hex — showing that verbatim in chat is
// unreadable and (with an unbroken hex string) overflows the layout. Always route
// user-facing tx failures through this.
export function cleanTxError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string } | undefined
  const raw = (e?.shortMessage || e?.message || String(err ?? '')).trim()
  const lower = raw.toLowerCase()

  if (/user rejected|user denied|denied (the )?transaction|rejected the request|action_rejected|request rejected/.test(lower)) {
    return 'You rejected the transaction in your wallet.'
  }
  if (/insufficient funds|exceeds balance|transfer amount exceeds/.test(lower)) {
    return 'Not enough balance to cover the amount plus gas.'
  }
  if (/chain mismatch|does not match|wrong network|chain not configured|unsupported chain/.test(lower)) {
    return 'Your wallet is on the wrong network — switch to Robinhood Chain and try again.'
  }
  if (/timeout|timed out/.test(lower)) {
    return 'The network timed out. Nothing was sent — try again in a moment.'
  }

  // Fallback: the first line only (never the calldata dump), truncated.
  const firstLine = raw.split('\n')[0].replace(/\s+/g, ' ').trim()
  if (!firstLine) return 'The transaction failed. Nothing was sent.'
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine
}
