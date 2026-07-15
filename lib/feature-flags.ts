// Build-time feature flags. Imported by both client components and server routes, so a
// single flip here (plus a redeploy) turns a feature fully on or off everywhere at once.

// Instant Swaps — the delegated session-signer wallet (Settings › Instant swaps) that lets
// Robin execute swaps WITHOUT a per-transaction approval. The code is built and working, but
// it is NOT part of the current public spec (the one-pager promises Robin "checks with you
// before anything moves"), so it ships HIDDEN and DISABLED until the next version. Flip to
// true and redeploy to bring back the Settings UI, the client routing, and the server
// endpoint together. Kept as one constant so enabling it is a single, reviewable change.
export const INSTANT_SWAPS_ENABLED = false
