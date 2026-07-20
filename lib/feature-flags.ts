// Build-time feature flags. Imported by both client components and server routes, so a
// single flip here (plus a redeploy) turns a feature fully on or off everywhere at once.

// Instant Swaps — the delegated session-signer wallet (Settings › Instant swaps) that lets
// Robin execute swaps WITHOUT a per-transaction approval. The code is built and working, but
// it is NOT part of the current public spec (the one-pager promises Robin "checks with you
// before anything moves"), so it ships HIDDEN and DISABLED until the next version. Flip to
// true and redeploy to bring back the Settings UI, the client routing, and the server
// endpoint together. Kept as one constant so enabling it is a single, reviewable change.
export const INSTANT_SWAPS_ENABLED = false

// Perps Agent LIVE EXECUTION. The read path (live Lighter market data) is always on; this
// flag controls only whether a real perps ORDER can be placed. It is off by default and must
// STAY off until (1) legal signs off on the eligible-jurisdiction list and (2) the perps
// executor service + credentials are provisioned. Even when true, every order still passes
// the jurisdiction geofence (lib/geo-gate.ts) — this flag can never override the geoblock for
// restricted regions (US/CA/UK/CH/UAE/SG). One switch, one reviewable change.
export const PERPS_ENABLED = process.env.PERPS_ENABLED === 'true'

// Per-user Lighter key onboarding (Settings › Perps trading key) — the non-custodial
// replacement for the shared-executor model above. Lets a user generate their own
// Lighter API keypair in-browser (WASM signer) and register it against their own
// Lighter account with a wallet signature; the key never touches Nock's servers. This
// is separate from PERPS_ENABLED because it's an independent, still-unfinished piece:
// it only covers account lookup + key registration (Phase 2), not yet wiring a perps
// trade's Confirm button to sign+submit client-side (that's next). Off by default —
// same one-flip convention as INSTANT_SWAPS_ENABLED.
export const PERPS_KEY_ONBOARDING_ENABLED = true
