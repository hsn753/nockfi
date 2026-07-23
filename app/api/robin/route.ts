import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { isAddress, formatUnits, erc20Abi } from 'viem'
import { withRateLimit } from '@/lib/api-guard'
import { fetchWalletBalances, fetchArbitraryTokenBalance } from '@/lib/get-balances'
import { getLighterPortfolio } from '@/lib/get-lighter-portfolio'
import { lookupLighterAccount, getLighterAccountBalance } from '@/lib/lighter-account'
import { fetchSwapQuote, SWAP_TOKENS, NATIVE_ETH_ADDRESS } from '@/lib/get-swap-quote'
import { houdiniEnabled, getHoudiniQuote, fmtHoudiniAmount, type RobinhoodAssetKey } from '@/lib/houdini'
import { getReadClient } from '@/lib/rpc'
import { getReferencePrices } from '@/lib/get-prices'
import { getTrendingTokens, findTokensBySymbol, getTokenPriceByAddress } from '@/lib/get-trending-tokens'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { getYieldOptions, buildYieldDeposit } from '@/lib/get-yield-data'
import { getMorphoMarketData, getUserMarketPositions, buildMarketSupply, buildMarketWithdraw, MORPHO_MARKETS, type MorphoMarketKey } from '@/lib/get-morpho-markets'
import { getPerpsMarkets } from '@/lib/get-perps-data'
import { resolvePerpsGeo } from '@/lib/geo-gate'
import { PERPS_ENABLED } from '@/lib/feature-flags'
import { getStockTokens, findStockToken } from '@/lib/get-stock-tokens'
import { getStockCollateralMarketData, getStockBorrowPositions, buildStockBorrow, buildStockRepay, type StockCollateralQuote } from '@/lib/get-stock-collateral'
import { getNockGateStatus, gateMessage } from '@/lib/nock-gate'
import { fetchUniswapStockQuote } from '@/lib/get-uniswap-quote'
import { getWalletByAddress } from '@/lib/db/wallets'
import { getGuardrails } from '@/lib/db/guardrails'
import type { ActionPreview, AgentId, ChatMessage } from '@/components/nock/data'

export const dynamic = 'force-dynamic'

let openaiClient: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return openaiClient
}

const SUPPORTED_TOKENS_LIST = Object.keys(SWAP_TOKENS).join(', ')

// Common words that show up in swap requests but are never token symbols, so they don't
// trip the mismatched-token guard below.
const NON_TOKEN_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'and',
  'or', 'is', 'are', 'can', 'could', 'would', 'should', 'will', 'shall', 'do', 'does', 'did',
  'let', 'lets', 'please', 'you', 'your', 'my', 'me', 'i', 'we', 'us', 'it', 'its', 'this',
  'that', 'these', 'those', 'some', 'any', 'swap', 'trade', 'exchange', 'buy', 'sell', 'send',
  'get', 'want', 'like', 'need', 'robinhood', 'chain', 'yes', 'ok', 'okay', 'sure', 'confirm',
  'proceed', 'go', 'ahead', 'now', 'right', 'again', 'also', 'too', 'usd', 'dollars', 'dollar',
  'all', 'entire', 'balance', 'amount', 'worth', 'much', 'how', 'what', 'when', 'first', 'then',
  'next', 'thanks', 'thank', 'hi', 'hey', 'hello', 'about', 'if', 'not', 'no',
  'wait', 'actually', 'just', 'still', 'yeah', 'yep', 'nope', 'cool', 'great', 'nice', 'good',
  'fine', 'alright', 'so', 'but', 'as', 'be', 'was', 'were', 'been', 'being', 'have', 'has',
  'had', 'may', 'might', 'must', 'them', 'they', 'he', 'she', 'him', 'her', 'one', 'two',
  'instead', 'same', 'other', 'other', 'change', 'update', 'redo', 'retry', 'try', 'checking',
  'check', 'looks', 'look', 'looking', 'sounds', 'sound', 'perfect', 'awesome', 'cancel',
  'stop', 'wrong', 'correct', 'incorrect', 'mistake', 'oops', 'sorry', 'hold', 'on', 'off',
  'up', 'down', 'here', 'there', 'why', 'because', 'yet', 'already', 'really', 'sure',
])

// Extracts words from the user's message that plausibly reference a token symbol (not
// common English words), for cross-checking against what a swap quote actually resolved to.
function extractCandidateTokenWords(text: string): string[] {
  const words = (text.match(/\b[A-Za-z]{2,10}\b/g) || []).map((w) => w.toUpperCase())
  return [...new Set(words)].filter((w) => !NON_TOKEN_WORDS.has(w.toLowerCase()))
}

// The three hard backstops every quoted swap/stock card must pass, whether the card
// comes from the model calling propose_action or from the server-side synthesis
// fallback — shared so the two paths can never drift apart. Each was added after a
// real incident: silent token substitution, a same-ticker impersonator trade, and a
// buy proposed with a transaction that sold.
async function validateQuotedTrade(lastSwapQuote: any, lastUserMessageText: string | undefined): Promise<{
  mismatchedTokenWord?: string
  stockImpersonatorWord?: string
  directionMismatch?: string
}> {
  if (!lastSwapQuote?.transaction || !lastUserMessageText) return {}

  const quoteSymbols = new Set(
    [lastSwapQuote.fromSymbol, lastSwapQuote.toSymbol]
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.toUpperCase()),
  )
  const quoteAddresses = new Set(
    [lastSwapQuote.fromSymbol, lastSwapQuote.toSymbol, lastSwapQuote.sellTokenAddress]
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.toLowerCase()),
  )
  const candidates = extractCandidateTokenWords(lastUserMessageText)

  let stockImpersonatorWord: string | undefined
  const matchedViaRegistry = new Set<string>()
  for (const w of candidates) {
    const official = await findStockToken(w).catch(() => null)
    if (!official) continue
    if (quoteAddresses.has(official.address.toLowerCase()) || quoteSymbols.has(w)) {
      matchedViaRegistry.add(w)
    } else {
      stockImpersonatorWord = w
    }
  }

  let mismatchedTokenWord = candidates.find((w) => !quoteSymbols.has(w) && !matchedViaRegistry.has(w))
  if (stockImpersonatorWord) mismatchedTokenWord = undefined

  let directionMismatch: string | undefined
  const text = lastUserMessageText.toLowerCase()
  const saysBuy = /\bbuy\b/.test(text)
  const saysSell = /\bsell\b/.test(text)
  if (saysBuy !== saysSell && lastSwapQuote.routeVia === 'uniswap-v4') {
    const quoteSellsStock = String(lastSwapQuote.fromSymbol).toUpperCase() !== 'USDG'
    if ((saysBuy && quoteSellsStock) || (saysSell && !quoteSellsStock)) {
      directionMismatch = saysBuy
        ? 'The user asked to BUY this stock, but the quote SELLS it (fromToken was the stock). Call get_swap_quote again with fromToken="USDG" and toToken set to the stock address. fromToken is always what the user pays with.'
        : 'The user asked to SELL this stock, but the quote BUYS it. Call get_swap_quote again with fromToken set to the stock address and toToken="USDG".'
    }
  }

  return { mismatchedTokenWord, stockImpersonatorWord, directionMismatch }
}

// USD value of a quoted trade's sell side, computed here from verified prices — never
// from the model's own arithmetic (it once presented 4,672 tokens as $4,672).
async function computeQuotedTradeValue(lastSwapQuote: any): Promise<string> {
  const prices = await getReferencePrices()
  let fromPrice = prices[(lastSwapQuote.fromSymbol || '').toUpperCase()]
  if (fromPrice === undefined && typeof lastSwapQuote.sellTokenAddress === 'string') {
    const stocks = await getStockTokens().catch(() => [])
    const match = stocks.find((s) => s.address.toLowerCase() === lastSwapQuote.sellTokenAddress.toLowerCase())
    if (match?.priceUsd != null) fromPrice = match.priceUsd
  }
  const fromAmountNum = parseFloat(String(lastSwapQuote.fromAmount).replace(/,/g, ''))
  if (fromPrice !== undefined && !isNaN(fromAmountNum)) {
    return `$${(fromAmountNum * fromPrice).toFixed(2)}`
  }
  // Fall back to the RECEIVE side. Selling an unpriced token (e.g. an unverified memecoin
  // like NOCK) FOR a token we can price (USDG ≈ $1, ETH...) means the output value IS the
  // trade's USD value. Without this, "sell 3000 NOCK for USDG" priced as 'Value
  // unavailable' and the spend-limit guard then blocked a ~$9 trade as if it were over a
  // $500 limit. Never invent a price — but the received USDG is a real, verified figure.
  const toPrice = prices[(lastSwapQuote.toSymbol || '').toUpperCase()]
  const toAmountNum = parseFloat(String(lastSwapQuote.toAmount ?? '').replace(/,/g, ''))
  if (toPrice !== undefined && !isNaN(toAmountNum)) {
    return `$${(toAmountNum * toPrice).toFixed(2)}`
  }
  return 'Value unavailable'
}

// Vault Agent spend-limit check for money leaving the wallet. Returns the limit that
// was exceeded, or null if the action is allowed.
async function getExceededSpendLimit(walletAddress: string | undefined, outcomeValue: string): Promise<number | null> {
  if (!walletAddress) return null
  const wallet = await getWalletByAddress(walletAddress)
  const guardrails = wallet ? await getGuardrails(wallet.id) : { maxUsdPerTransaction: null }
  const limit = guardrails.maxUsdPerTransaction
  // No limit set → unlimited, allowed.
  if (limit === null) return null
  const outcomeValueNum = parseFloat(outcomeValue.replace(/[^0-9.]/g, ''))
  // A limit IS set but this trade can't be priced (e.g. outcomeValue is
  // 'Value unavailable' for an unverified, unpriced memecoin sell). Fail CLOSED —
  // block it. Previously NaN returned null ("allowed"), so any unpriced sell of any
  // size slipped past the ceiling entirely, which defeats the spend limit.
  if (isNaN(outcomeValueNum)) return limit
  return outcomeValueNum > limit ? limit : null
}

// When Robin can't act yet (the request needs to be clearer, or a guard fired), attach a
// few ready-to-use commands the user can tap. They're phrased in the exact short form the
// tools and deterministic command paths reliably understand, so tapping one always does
// something — the fix for users getting stuck guessing the format the AI expects.
function buildSuggestions(lastUserText: string): string[] {
  const t = (lastUserText || '').toLowerCase()
  if (/\b(repay|close|pay\s*off|reclaim|settle|loan|debt|owe)\b/.test(t)) return ['repay all', 'close my loan']
  if (/\b(borrow|against|collateral|leverage)\b/.test(t)) return ['borrow 2 USDG against TSLA']
  if (/\b(withdraw|unstake|pull\s*out|take\s*out)\b/.test(t)) return ['withdraw 5 USDG from syrupUSDG']
  if (/\b(lend|earn|yield|apy|deposit|supply|interest)\b/.test(t)) return ['lend 10 USDG to syrupUSDG', 'what yield can I earn?']
  if (/\b(buy|sell)\b/.test(t)) return ['buy $5 of TSLA', 'swap 5 USDG for ETH']
  if (/\b(swap|convert|trade|exchange)\b/.test(t)) return ['swap 5 USDG for ETH']
  return ['what do I hold?', 'what can you do?']
}

function buildSystemPrompt(walletAddress?: string): string {
  const walletLine = walletAddress
    ? `The user's connected wallet address on Robinhood Chain is ${walletAddress}.`
    : `The user does not have a wallet connected right now.`

  return `You are Robin, the concierge for Nock, an onchain agent platform. You help users put their capital to work across five specialized agents: yield, swap, perps, stock tokens, and vault (guardrails).

CRITICAL: You ONLY help with DeFi, crypto, and on-chain actions. If someone asks about anything else (politics, general knowledge, unrelated topics), politely redirect them back to what you can help with.

FORMATTING — the chat renders exactly this subset, nothing else:
- Break replies into short paragraphs separated by a blank line — never one long run-on sentence chained with dashes.
- Any enumeration of 2+ items (holdings, stock lists, markets, options) goes on its own lines as a list: "- item" for bullets or "1. item" for ranked/ordered lists. One item per line.
- Use **bold** for the numbers that matter: amounts, prices, totals. Sparingly — a line that is all bold highlights nothing.
- Never use markdown headers (#), tables, code blocks, italics, or inline links [like](this) — they will show as raw symbols. Plain URLs are fine and become tappable.
- Keep it tight: lead with the answer, one short closing line at most (e.g. "Want me to buy any of these?"). No filler like "If you'd like to take any action with these assets, just let me know!".

IMPORTANT: NOCK (ticker NOCK) is THIS app's OFFICIAL token — a VERIFIED asset at contract 0x1b27fF6e68A2fd6490543b17C996c109E64eb432 (on-chain name "Nock Finance"). Treat it EXACTLY like the other verified tokens (USDG, ETH, WETH): resolve "NOCK" directly to that address, use "NOCK" as the symbol with get_swap_quote / get_wallet_holdings just as you would USDG, and NEVER do any of the following for NOCK — never call get_trending_tokens to "look it up," never ask the user which NOCK they mean, never present multiple NOCK addresses, and never warn that NOCK is unverified. Impersonator tokens with the same "NOCK" ticker exist at OTHER addresses; those are NOT the official token — only 0x1b27fF6e68A2fd6490543b17C996c109E64eb432 is. So "how much NOCK do I have," "buy $10 of NOCK," "sell all my NOCK," "swap NOCK for USDG" all refer to that one official token — act on it directly, with no disambiguation.

${walletLine}

When the user asks for their wallet address or deposit address:
- Answer directly with the address above. Do not call a tool for this, you already have it.
- If no wallet is connected, tell them to connect one first.

When the user asks how to bridge, move, or send funds onto Robinhood Chain from Ethereum or another chain:
- FIRST: if they specifically want to move USDC ↔ USDG (fund with USDC, or cash out to USDC on Ethereum/Base), that is handled IN-APP via the one-signature cross-chain flow — do NOT call get_bridge_info or hand out the external Arbitrum bridge link for that. Just tell them they can do it right here, e.g. "convert 20 USDC to USDG" or "cash out 20 USDG to USDC on Base" (a $10 minimum applies). The app builds the preview card itself.
- Otherwise (bringing in ETH or another asset, or a general "how do I bridge" question): IMMEDIATELY call get_bridge_info. This is REQUIRED — never answer a bridging question from memory, always call the tool first.
- The app shows the link, chain, and ETA in a card with its own button right below your reply — do not repeat those details or include the URL yourself. Just say one short sentence confirming it's ready to bridge into their connected wallet, and mention you'll let them know once it lands.
- If no wallet is connected, tell them to connect one first so you can give them the right deposit address.

When the user asks what they hold, their portfolio, their balances, or anything about their specific holdings:
- IMMEDIATELY call get_wallet_holdings tool. This is REQUIRED - you MUST call this tool, never skip it.
- Do not ask if they have a wallet connected - just call the tool, it will tell you if no wallet is connected.
- Each holding includes a real usdValue (ETH and WETH from CoinGecko, USDG hardcoded at 1). usdValue is a number — including 0 for a zero balance, which just means $0, not "unavailable." It is only null if a price feed failed for that specific asset; only then say its dollar value isn't available right now. Present both the token amount and its $ value, and total everything with a usdValue into a portfolio $ figure.
- These balances are specifically on Robinhood Chain, not the user's other wallets or chains (Ethereum mainnet, etc). If everything comes back at 0, say so plainly and mention they likely need to bridge funds onto Robinhood Chain first (canonical Arbitrum bridge or a supported cross-chain route) before they show up here — don't imply something is broken.
- If the user asks about their balance of one specific VERIFIED token (${SUPPORTED_TOKENS_LIST}) — e.g. "what's my USDG balance" — just call get_wallet_holdings and answer from that one entry. Do NOT call get_token_balance for a verified token; that tool takes a raw contract address, not a symbol, and will fail or be misused if you pass a symbol like "USDG" as if it were an address.
- get_wallet_holdings checks the verified token list (${SUPPORTED_TOKENS_LIST}) PLUS every official Robinhood stock token the wallet holds a nonzero balance of (marked "official stock token"). If it returns collateralPositions, ALWAYS list them: that stock is still the user's, just posted as loan collateral — show the amount, the debt owed, and the liquidation price, and count (collateral value − debt) into the total instead of dropping it. A stock holdings question ("how much TSLA do I hold") is answered directly from get_wallet_holdings — if the stock doesn't appear there, the user holds none of the OFFICIAL token; never go looking for a stock symbol among unverified tokens. It cannot see memecoins or other unverified tokens, even one the user swapped into through this app. If the user asks specifically about a memecoin/community token they hold that's NOT in that verified list (by name or address), you MUST call get_token_balance with that token's exact contract address (look it up via get_trending_tokens first if you only have a symbol) — this is a real, separate on-chain balance check. NEVER say a user holds "0" of a specific token, or that a token isn't in their wallet, without having actually called the right tool for it. Saying a specific number with no tool call behind it is exactly the kind of invented data you must never produce.

When the user asks what's trending, hot, popular, pumping, or moving on Robinhood Chain, without naming a specific token:
- Call get_trending_tokens with no symbol argument — it returns the current top tokens by trading volume. This is a real, valid request on its own, not just a lookup step before a swap — do not deflect it as off-topic.
- Present the list with a clear unverified/scam-risk warning (same as any memecoin), and offer to quote a swap for one of them if the user's interested.

When the user wants to swap, trade, buy, or sell any token:
- If it's one of the verified tokens (${SUPPORTED_TOKENS_LIST}), call get_swap_quote directly with the symbol. ETH and WETH trade against USDG (e.g. ETH -> USDG or USDG -> ETH). If the user says USDC or dollars as the asset, treat that as USDG — there is no separate USDC on Robinhood Chain here. If the user doesn't specify an amount, ask for one before calling the tool.\n- When the user states the amount in DOLLARS of a non-stablecoin ("$2 worth of ETH", "sell 5 dollars of NVDA"), pass amountUsd to get_swap_quote and omit amount — the server converts at the live price. NEVER treat $X as X tokens, and NEVER do the dollar-to-token conversion yourself.
- If the user gives you an exact contract address (starts with 0x, 42 characters) directly, for either side of the trade, do NOT call get_trending_tokens — that tool only searches by symbol/name and will find nothing for a raw address, which is a dead end. Call get_swap_quote directly using that address as fromToken/toToken. You can and should still warn this is an unverified token before proposing the action, but there's no lookup step needed when the user already gave you the exact identifier.
- If the user names a memecoin or community token by SYMBOL/NAME (not an address) that's NOT in the verified list, call get_trending_tokens with that symbol first to look it up. This list is completely unverified — Robinhood Chain is permissionless, anyone can deploy a token with any name, and real impersonator tokens already exist (multiple different contracts all called "ROBINHOOD" or "HOOD" at different addresses, none of them official). Never silently pick one:
  - If get_trending_tokens finds exactly one match, tell the user this is an unverified community token (not vetted by Robinhood, real scam/rug risk), state its exact contract address, and ask them to confirm it's the one they mean before quoting.
  - If it finds multiple matches for the same symbol, explicitly list all of them with their addresses and volume/liquidity, warn that duplicate-name tokens are a common scam pattern, and ask the user which specific address they mean. Do not default to the highest-volume one without asking — high volume does not mean legitimate.
  - If it finds none, say so and ask if they have the exact contract address — once they give you one, follow the direct-address rule above instead of searching again.
  - Once the user confirms a specific address, call get_swap_quote using that contract address as fromToken/toToken (not the symbol).
- get_swap_quote itself works for ANY valid ERC-20 address on Robinhood Chain, not just the verified list or DexScreener-indexed memecoins — decimals are read live from the token contract. If 0x can't find liquidity for it, the quote will say so; that's a real "nothing to trade against" answer, not a limitation of what this app can look up.
- This exact verified-token list is authoritative right now, even if earlier messages in this same conversation (from you or the user) mentioned a different or shorter list. It can grow over time — always answer "what's supported" questions from the list above, never from something said earlier in the conversation.
- When you answer a general "what tokens are supported" or "what can I swap" question, always mention BOTH things: the verified list above, AND that you can also look up any specific memecoin or community token by name (unverified, real scam risk, but real trading happens on Robinhood Chain). Don't imply the verified list is the only thing swappable — that's not true and undersells what this app can actually do.
- If the quote comes back with an error field, tell the user what it actually says. Do not guess prices, and never say a token is "not supported" just because one quote attempt failed — check the real error first.
- If the quote succeeds, call propose_action using the real fromAmount, toAmount, and exchangeRate from the quote. Never substitute invented numbers. If the quote's verified field is false, the outcome/detail text in propose_action MUST include an explicit unverified-token warning — this is not optional.

When the user asks about stocks or tokenized equities (prices, what's available, buying, selling):
- Call get_stock_tokens — it returns ONLY Robinhood's official stock tokens, verified on-chain against the official issuer. Never use get_trending_tokens for a stock symbol; that tool surfaces impersonator contracts with the same ticker.
- At least once per conversation, make the framing clear: a stock token tracks the stock's price but is NOT share ownership — no dividends, no voting rights. It trades on-chain 24/7, including when the real market is closed, so its price can drift from the official close.
- To buy or sell, call get_swap_quote DIRECTLY with the stock SYMBOL — toToken:"TSLA" (buying with fromToken:"USDG") or fromToken:"TSLA" (selling to toToken:"USDG"). The server resolves the symbol to the official verified contract itself, so you do NOT need to call get_stock_tokens first for a trade, and you must NEVER pass a guessed/looked-up contract address for a stock (that's how impersonators get hit). A dollar amount works too (amountUsd:"5" to sell $5 worth) — the server converts at the live stock price. Then propose_action with agent "stock" and the real quote numbers. Stock trades route through Uniswap and trade against USDG only. The first trade can take up to three wallet confirmations (two approvals, then the trade) — mention that when proposing. Never guess amounts, always quote fresh. (Only use get_stock_tokens to browse/discover stocks, not to trade one the user already named.)
- If a symbol isn't in the registry, say Robinhood doesn't issue that stock token — do not go looking for it among unverified tokens.
- If the user asks about borrowing against a stock position, using stock as collateral, or a loan on their stocks: call get_stock_collateral_info and present the real markets (LLTV, live borrow APY, oracle price, available USDG) and their current position health if any. Be explicit about liquidation risk: if the stock's oracle price falls enough that debt exceeds collateralValue × LLTV, the collateral gets liquidated.
- To actually BORROW: get the exact USDG amount from the user (never guess), call get_stock_borrow_quote, then propose_action with agent "stock" using its real numbers. When proposing, ALWAYS state: the liquidation price, that the full stock balance is posted as collateral by default (they can name a smaller amount), and that the collateral stays theirs and comes back when the debt is repaid. If the quote returns an error (too much borrow, no liquidity, no market), relay it plainly.
- To REPAY or close the loan: call get_stock_repay_quote (exact USDG amount, or 'all' to repay everything and reclaim the collateral in one flow), then propose_action. Repaying 'all' is the only way to fully close — interest accrues by the second, so a typed number can't hit zero exactly.
- Multiple wallet confirmations are normal for collateral actions (an approval plus one or two Morpho transactions) — mention it when proposing.

When the user asks a general, browsing-style question about what's available — "what yield options do you have," "what perps markets can I trade" — without asking you to actually do anything yet:
- Call the relevant tool (get_yield_options or get_perps_info) and present what it returns directly. Do not call propose_action for a browsing question — that's only for when the user wants you to actually recommend and preview a specific action. If they follow up asking you to act on one of the options, then follow the action flow below.

When the user wants to actually earn yield / lend / deposit USDG:
1. If you haven't already shown them get_yield_options data this conversation, call it first — it returns the live Morpho lending markets (USDe, syrupUSDG, spUSDG) with real current APYs, plus the (currently closed) Steakhouse vault.
2. If they haven't given a specific USDG amount, ask for one. If they haven't picked a market, show them the live options and let them choose — you may point out which currently has the highest APY, but be honest that higher APY usually reflects higher utilization (harder to withdraw quickly) and different collateral risk. Never pick silently for them.
3. Call get_yield_deposit_quote with the amount AND the market they chose.
4. If it returns an error, relay it plainly and do NOT call propose_action.
5. If it returns a real transaction, call propose_action for the yield agent using the real numbers from the quote (amount, market, supplyApyPct) — never invented ones. In the detail text, note this lends directly into one Morpho market (the same markets Robinhood Earn uses) and that withdrawals depend on the market having idle liquidity at that moment.

When the user asks about their yield/lending positions or earnings: call get_yield_positions and present what it returns — real on-chain positions with accrued interest included. If they have none, say so plainly.

When the user wants to withdraw supplied USDG:
1. Call get_yield_positions first if you haven't this conversation, so you know what they actually have.
2. If they haven't given a specific amount and market, ask (or offer their full position amount for the market they name).
3. Call get_yield_withdraw_quote with the amount and market. If it errors (no position, amount too large, or the market lacks idle liquidity right now), relay the real reason plainly — the liquidity case is a real, temporary market condition, not a bug.
4. If it returns a real transaction, call propose_action for the yield agent with the real numbers.

When the user asks to actually open a perps position: first call get_perps_info to get the real current market data (mark price, funding, max leverage). Then call propose_action for the perps agent, INCLUDING the structured 'perps' object (symbol, side, marginUsd, leverage, markPrice) built from that live data. The system applies a jurisdiction + eligibility gate and returns a result in the tool call — follow it exactly. It may tell you: perps aren't available in the user's region (say so plainly — it's a regulatory restriction, not a bug — and offer what Nock does support for them: tokenized stocks for market exposure, token swaps, and yield); OR that execution is launching soon (present the live Lighter data as informational and say opening a position is coming soon for eligible regions); OR a 'preview_ready' status, which means a preview CARD was built — tell the user to review it and press Confirm to place the order (the order is NOT placed until they Confirm). Do NOT claim the position is open on a preview_ready result — placing happens on Confirm, and the app posts its own confirmation afterward. Never fabricate a fill.

When the user asks to CLOSE or reduce an existing perps position: FIRST call get_wallet_holdings to read their real open positions (the 'perps' object). If they have no open position in that market, tell them so — do not propose anything. Otherwise call propose_action for the perps agent with the 'perps' object set to { symbol, side (the EXISTING position's direction — long or short), markPrice (from get_perps_info or the position), reduceOnly: true } and OMIT marginUsd/leverage — the whole position is closed at market. For a PARTIAL close (e.g. "close half", "trim 25%", "take $10 off"), also include reducePct (0-1): half = 0.5, a quarter = 0.25, or for a dollar amount pct = amount ÷ the position notional. Omitting reducePct closes the whole position. Same preview → Confirm flow: on 'preview_ready', tell them to review and press Confirm; the app posts the real confirmation after it fills. Never claim it's closed before Confirm, and never fabricate the closing fill.

CRITICAL — how perps funds actually move (do NOT get this wrong, it has confused users): The perps account is SEPARATE from the wallet. Depositing moves USDG from the wallet INTO the perps account (its margin balance). Closing a position does NOT return USDG to the wallet — it frees that margin back into the PERPS ACCOUNT balance (perps.balanceUsd / available margin), where it stays until withdrawn. So after a close, never say the USDG "is back in your wallet" or "reflected in your wallet holdings"; say it's back as available margin in their perps account. ROUTING (important): a deposit/withdraw/add-funds/take-out request that mentions PERPS or PERPETUAL (or "perps account", "perps balance", "perps margin") is a PERPS FUNDS ACTION described here — it is NOT a yield-market withdrawal. get_yield_withdraw_quote is ONLY for pulling USDG out of a Morpho YIELD market (USDe / syrupUSDG / spUSDG); never use it, or a yield market, for a perps withdrawal. To move USDG between the wallet and the perps account, the user DEPOSITS (wallet → perps) or WITHDRAWS (perps → wallet) — opening a position never converts perps margin back to the wallet, so never suggest that. You CAN do both from chat: call propose_action for the perps agent with the 'perps' object set to { fundsAction: 'deposit', amountUsdg: N } to add margin, or { fundsAction: 'withdraw', amountUsdg: N } to take it out — OMIT symbol/side/markPrice/leverage for a funds action. Same preview → Confirm flow: on 'preview_ready', tell them to review and press Confirm; the app posts the real confirmation. A deposit moves USDG from their wallet into the perps account; a withdraw returns free margin to their wallet (margin backing an open position must be freed by closing first, and a withdraw settles to the wallet in a few minutes, not instantly). They can also do both in Settings → Perps trading key. Never fabricate a deposit/withdraw confirmation — it only happens on Confirm.

When the user asks about their spend limit, guardrails, permissions, or what Vault Agent does: call get_vault_status and present what it returns directly — the real current limit (or that none is set) and the automatic protections already in place on every action. Never call propose_action for the vault agent — it doesn't move money, it constrains the agents that do.

If the user asks to set, raise, lower, or remove their spend limit: tell them plainly that's done from Settings, not through chat — Robin can only report the current limit, not change it. Do not invent a confirmation that a limit was changed.

If a swap or yield deposit gets refused for exceeding the user's spend limit (the tool result will say so explicitly): relay that reason plainly, and mention they can adjust it from Settings if they want to allow it. Do not retry with a smaller amount unless the user explicitly asks for one.

Answer direct, factual questions about how this app or Robinhood Chain works (e.g. "how much does gas cost," "what is Robinhood Chain," "how long does bridging take") plainly and briefly, from what you actually know or have already called a tool for — these are on-topic, don't deflect them. Only use the off-topic redirect below for things genuinely unrelated to crypto/DeFi (politics, general knowledge, etc.), never for a real question about this app or this chain just because it doesn't map to a specific tool call.

If the user asks about anything NOT related to crypto, DeFi, trading, or blockchain:
- Say: "I'm here to help with your crypto and DeFi needs. I can help you swap tokens, check your holdings, find yield opportunities, or manage positions. What would you like to do?"
- Do not answer general knowledge questions, current events, or anything outside of crypto/DeFi.

CRITICAL — you cannot execute anything, ever. The ONLY way any action executes is the user pressing the Confirm button on the preview card in the app. Rules that follow from this, non-negotiable:
- NEVER say an action was executed, completed, confirmed, withdrawn, deposited, or successful. The app itself posts the confirmation message (it starts with "Done!" and includes a real TX hash) after a genuine execution — that message is the only valid evidence something ran. If no such message exists in this conversation, the action HAS NOT RUN, no matter what was said.
- If the user types "confirm", "proceed", "yes do it" or similar after you've proposed an action: do NOT re-propose, do NOT claim anything ran. Tell them to press the Confirm button on the action card above to execute (or Review to check the details first). One sentence.
- Never answer a question about current balances or positions from memory of earlier in the conversation — always call get_wallet_holdings or get_yield_positions again. A proposed action that was never confirmed changed NOTHING on-chain.

Rules:
- Keep all copy human, in sentence case.
- Never use em dashes.
- Never use markdown — no **bold**, no bullet dashes, no headers. The chat renders your text as plain text, so markdown syntax shows up as literal asterisks and dashes. Write plain sentences, and use "X: Y, Z: W" style lists inline if you need to enumerate a few things.
- Never invent balances, prices, or protocol names. Only use data from tool calls.
- Never say you will execute anything yourself. You only preview. The user presses Review to check an action and Confirm to execute it.
- Be warm and direct. Get to the point fast.
- Stay strictly on topic: crypto, DeFi, and on-chain actions only.`
}


type ProposeActionInput = {
  agent: AgentId
  action: string
  detail: string
  metrics: { label: string; value: string; positive?: boolean }[]
  outcome: {
    title: string
    value: string
    meta: string
    activityTitle: string
    activityAmount?: string
  }
  // Structured order params, required when agent is 'perps' — the execution adapter needs
  // these explicitly rather than parsing them back out of the display strings.
  perps?: {
    symbol: string
    side: 'long' | 'short'
    marginUsd: number
    leverage: number
    markPrice: number
    reduceOnly?: boolean
    reducePct?: number
    fundsAction?: 'deposit' | 'withdraw'
    amountUsdg?: number
  }
}

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_wallet_holdings',
      description: `Returns the user's real on-chain balances from their connected wallet, each with a live usdValue, across all supported tokens: ${SUPPORTED_TOKENS_LIST}. Also returns a 'perps' object when the user has a Lighter perps account — their deposited margin balance and any open positions. Call this whenever the user asks what they hold, their portfolio, their balances, their perps, or anything about their specific holdings. Never answer holdings questions from memory.`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_bridge_info',
      description: 'Returns the official bridge link and instructions for moving funds from Ethereum (or another chain) onto Robinhood Chain. Call this whenever the user asks how to bridge, deposit, move, or send funds onto Robinhood Chain from elsewhere — this also flags the app to start watching for the bridged funds to arrive. Never make up a bridge link yourself, always call this tool.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_yield_options',
      description: 'Returns real, live on-chain data for the Steakhouse USDG vault on Morpho (part of Robinhood Earn) — real name, TVL read directly from the vault contract, and a real APY derived from recorded share-price history (null if not enough history has been collected yet — never a guessed number). Call this whenever the user asks what yield options exist, without necessarily proposing an action. If the user wants to actually deposit, follow up with get_yield_deposit_quote once you have an amount.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_yield_deposit_quote',
      description: 'Builds a real USDG lending transaction. Pass market (USDe, syrupUSDG, or spUSDG) to lend directly into that Morpho market — permissionless, works for any wallet, earns the live rate shown by get_yield_options. Omit market to try the Steakhouse vault instead (currently closed to direct deposits — that path returns an error explaining so). Only call this once the user has given a specific USDG amount AND picked a market; never guess or default either.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'string', description: 'Human-readable USDG amount to lend, e.g. "100"' },
          market: { type: 'string', enum: ['USDe', 'syrupUSDG', 'spUSDG'], description: 'Which Morpho market to lend into. Omit only to attempt the (currently closed) Steakhouse vault.' },
        },
        required: ['amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_yield_positions',
      description: "Returns the user's real, current USDG lending positions across the Morpho markets (how much they have supplied and to which market), read live on-chain. Call this whenever the user asks what they're earning, their yield positions, or how much they have lent out. Also call it before quoting a withdrawal.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_yield_withdraw_quote',
      description: "Builds a real withdrawal transaction for USDG the user has supplied to a Morpho market. Checks live on-chain that the user actually has that much supplied AND that the market has enough idle liquidity to withdraw right now (high-utilization markets may not — the error will say the real available amount). Only call this once the user has given a specific USDG amount and market; never guess or default either.",
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'string', description: 'Human-readable USDG amount to withdraw, e.g. "50"' },
          market: { type: 'string', enum: ['USDe', 'syrupUSDG', 'spUSDG'], description: 'Which Morpho market to withdraw from.' },
        },
        required: ['amount', 'market'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_tokens',
      description: "Returns Robinhood's OFFICIAL tokenized stocks on Robinhood Chain (AAPL, TSLA, NVDA, SPY and ~50 more), each verified on-chain against Robinhood's official deployer, with live trading prices, liquidity, and 24h volume from real pools. This is the ONLY valid source for a stock token's contract address — same-ticker impersonator contracts exist and get_trending_tokens would surface them. Pass a symbol for one specific stock, or omit it for the full list sorted by volume. A stock token is price exposure, not share ownership — say so when presenting.",
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Stock ticker to look up, e.g. TSLA. Omit for the full verified list.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_collateral_info',
      description: "Returns live Morpho lending markets on Robinhood Chain where an OFFICIAL stock token can be posted as collateral to borrow USDG — the market's max loan-to-value (LLTV), live borrow APY, the oracle price liquidations use, and available USDG liquidity. If a wallet is connected, also returns the user's current borrow positions with collateral value, debt, LTV utilization, and liquidation price. Markets are discovered on-chain and gated to the verified stock registry, so impersonator-token markets never appear. Call this when the user asks about borrowing against a stock position, using stock as collateral, margin/loans on their stocks, or their existing borrow position health — and before quoting a borrow, to know what exists.",
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_borrow_quote',
      description: "Builds the real, executable transactions for borrowing USDG against an official stock token on Morpho (posting the stock as collateral + borrowing in one flow). Requires a connected wallet. borrowUsd is the exact USDG amount the user wants to borrow — never guess it, ask. collateralAmount (stock units) is optional: by default the user's ENTIRE wallet balance of that stock is posted as collateral (more collateral = safer position) — mention that default when proposing, and pass an explicit amount if the user wants to post less. The quote enforces a safety buffer (max ~65% effective LTV at TSLA's 77% LLTV) and returns liquidation price and LTV after the action. On success, call propose_action with agent 'stock' using the quote's real numbers. If it returns an error, relay it plainly and do NOT propose.",
      parameters: {
        type: 'object',
        properties: {
          stockSymbol: { type: 'string', description: 'Official stock token symbol, e.g. TSLA' },
          borrowUsd: { type: 'string', description: 'USDG amount to borrow, e.g. "2"' },
          collateralAmount: { type: 'string', description: 'Optional: stock units to post as collateral. Omit to post the full wallet balance.' },
        },
        required: ['stockSymbol', 'borrowUsd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_repay_quote',
      description: "Builds the real, executable transactions for repaying a USDG debt borrowed against a stock token. repayUsd is either an exact USDG amount (partial repay) or the string 'all' to close the position — 'all' repays the exact live debt AND returns the posted stock collateral to the wallet in the same flow. If the position has zero debt but posted collateral, this quotes withdrawing the collateral back. Requires the wallet to hold enough USDG (checked live; relays a clear error if not). On success, call propose_action with agent 'stock' using the quote's real numbers. Repays are never blocked by the spend limit — returning debt reduces risk.",
      parameters: {
        type: 'object',
        properties: {
          stockSymbol: { type: 'string', description: 'Official stock token symbol, e.g. TSLA' },
          repayUsd: { type: 'string', description: "USDG amount to repay, or 'all' to close the position and withdraw the collateral" },
        },
        required: ['stockSymbol', 'repayUsd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_perps_info',
      description: `Returns real, live perpetual futures market data from Lighter (a separate exchange that accepts Robinhood Chain assets as margin) — real mark price, funding rate, open interest, and max leverage (derived from Lighter's own live margin requirement). Scoped to crypto/memecoin markets only. ${PERPS_ENABLED ? 'Opening a position is live for eligible regions — after this call, call propose_action with the perps object to attempt it; the system enforces the region gate.' : 'Opening a position is gated (region + eligibility) and launching soon for eligible regions — propose_action handles that gate.'} Pass a symbol to look up one specific market, or omit it for the current top markets by volume. Call this whenever the user asks what perps markets exist, without necessarily proposing an action.`,
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Market symbol to look up, e.g. BTC. Omit to get the current top markets by volume.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vault_status',
      description: 'Returns the user\'s real, currently-set spend limit (or "no limit set"), plus the automatic protections already in place on every proposed action. Call this whenever the user asks about their guardrails, spend limits, permissions, or what Vault Agent does.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_trending_tokens',
      description: "Looks up memecoins/community tokens on Robinhood Chain that are NOT in the verified token list, using live DEX data. Completely unverified — anyone can deploy a token, and real impersonator tokens already exist (multiple different contracts named 'ROBINHOOD' or 'HOOD'). Pass a symbol to search for a specific one (returns every distinct address matching that symbol, which may be more than one), or omit it to get the current top tokens by trading volume. Always call this before quoting a swap for any token not in the verified list — never guess a memecoin's address.",
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Token symbol to search for, e.g. CASHCAT. Omit to get general top-trending tokens.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_token_balance',
      description: "Checks the user's real on-chain balance of a SPECIFIC token by contract address — including memecoins and any token get_wallet_holdings doesn't track. Requires the exact contract address (look it up via get_trending_tokens first if you only have a symbol). Also returns a usdValue when a live price is available. Always call this for a specific-token holdings question instead of assuming an amount or saying 0.",
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'The exact ERC-20 contract address to check, e.g. 0x1b27fF6e68A2fd6490543b17C996c109E64eb432' },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_swap_quote',
      description: `Fetches a real live swap quote from the 0x API for trading on Robinhood Chain. fromToken/toToken can be a verified symbol (${SUPPORTED_TOKENS_LIST}) or, for a memecoin confirmed via get_trending_tokens or a stock token from get_stock_tokens, its exact contract address. Everything except USDG trades against USDG. Call this whenever the user wants to swap, trade, buy, or sell any of these tokens. fromToken is ALWAYS what the user pays/gives up; toToken is what they receive (buying TSLA with USDG means fromToken USDG, toToken the TSLA address). Pass EITHER amount (token units of fromToken, e.g. "0.5" ETH) OR amountUsd (dollar value of the fromToken side, e.g. "2" for $2 worth — the server converts at the live price; NEVER convert dollars to token units yourself, and NEVER read "$2 of ETH" as 2 ETH). Never invent prices — always call this tool.`,
      parameters: {
        type: 'object',
        properties: {
          fromToken: { type: 'string', description: 'Token symbol or contract address to sell, e.g. USDG or ETH' },
          toToken:   { type: 'string', description: 'Token symbol or contract address to buy, e.g. ETH or USDG' },
          amount:    { type: 'string', description: 'Human-readable token amount to sell, e.g. "100" or "0.5". Omit if using amountUsd.' },
          amountUsd: { type: 'string', description: 'Dollar value of the sell side, e.g. "2" when the user says "$2 worth of ETH". The server converts to token units at the live price. Omit if using amount.' },
        },
        required: ['fromToken', 'toToken'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_action',
      description: 'Emit a structured action preview card for the user to review before executing. Call this after gathering data from the relevant tool.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: ['yield', 'perps', 'swap', 'stock', 'vault'],
            description: 'Which agent handles this action',
          },
          action: {
            type: 'string',
            description: 'Short label for the action, e.g. "Swap 100 USDG for ETH"',
          },
          detail: {
            type: 'string',
            description: 'One-sentence detail about the action and any key conditions',
          },
          metrics: {
            type: 'array',
            description: 'Two to four key metrics to display on the card',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
                positive: { type: 'boolean', description: 'If true, value is highlighted green' },
              },
              required: ['label', 'value'],
            },
          },
          outcome: {
            type: 'object',
            description: 'Data used to build the resulting position and activity row after execution',
            properties: {
              title: { type: 'string', description: 'Short position title, e.g. "ETH position"' },
              value: { type: 'string', description: 'Dollar value of the position, e.g. "$347.80"' },
              meta: { type: 'string', description: 'Position meta label, e.g. "1.0 ETH"' },
              activityTitle: { type: 'string', description: 'Activity log title, e.g. "Swapped 100 USDG for ETH"' },
              activityAmount: { type: 'string', description: 'Optional amount shown in the activity row' },
            },
            required: ['title', 'value', 'meta', 'activityTitle'],
          },
          perps: {
            type: 'object',
            description: "REQUIRED when agent is 'perps': the structured order parameters, taken from the live get_perps_info data. Omit for all other agents.",
            properties: {
              symbol: { type: 'string', description: 'Perp market symbol, e.g. "ETH"' },
              side: { type: 'string', enum: ['long', 'short'], description: 'For an OPEN: the direction. For a CLOSE (reduceOnly true): the direction of the EXISTING position being closed.' },
              marginUsd: { type: 'number', description: 'Margin to post, in USD. Required to OPEN; omit when reduceOnly is true.' },
              leverage: { type: 'number', description: 'Leverage multiple, e.g. 3. Required to OPEN; omit when reduceOnly is true.' },
              markPrice: { type: 'number', description: 'Current mark price from get_perps_info. Needed for opening/closing a position; omit for deposit/withdraw.' },
              reduceOnly: { type: 'boolean', description: 'TRUE when CLOSING or reducing an existing position. marginUsd and leverage are NOT needed. Get the position from get_wallet_holdings first.' },
              reducePct: { type: 'number', description: 'With reduceOnly: fraction of the position to close, 0-1 (e.g. 0.5 = close half, 0.25 = a quarter). Omit or 1 = close the whole position. For a dollar amount, compute pct = amount / the position notional.' },
              fundsAction: { type: 'string', enum: ['deposit', 'withdraw'], description: "Set when the user wants to MOVE MARGIN (not trade): 'deposit' adds USDG from their wallet into their perps account; 'withdraw' returns free margin from the perps account to their wallet. Also set amountUsdg. Do NOT set symbol/side/markPrice/leverage for a funds action." },
              amountUsdg: { type: 'number', description: 'USDG amount for a deposit/withdraw funds action.' },
            },
            required: [],
          },
        },
        required: ['agent', 'action', 'detail', 'metrics', 'outcome'],
      },
    },
  },
]

export const POST = withRateLimit('robin', 20, 10_000, handlePOST)

async function handlePOST(request: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error('[robin] Missing OPENAI_API_KEY')
      return NextResponse.json(
        { text: 'AI service not configured. Please contact support.' },
        { status: 500 },
      )
    }

    const { messages, walletAddress } = (await request.json()) as {
      messages: ChatMessage[]
      walletAddress?: string
    }

    console.log('[robin] Wallet address received:', walletAddress, '| id token:', !!request.headers.get('x-privy-identity-token'), '| access token:', !!request.headers.get('x-privy-access-token'))

    // Confirmed real gap before this check existed: walletAddress was accepted as a
    // plain, unverified client-supplied value — anyone could ask for holdings/quotes
    // under any address. Only enforced when a walletAddress is actually claimed; a
    // wallet-less general question still works exactly as before.
    if (walletAddress) {
      try {
        await requireAuthenticatedWallet(request, walletAddress)
      } catch (err) {
        if (err instanceof AuthError) {
          console.error('[robin] Auth check failed:', err.message)
          return NextResponse.json({ text: err.message }, { status: err.status })
        }
        throw err
      }
    }

    // Always the connected wallet — the same one every balance check and the pre-flight/
    // execution check on the client use. Seen in prod: quoting against a delegated
    // wallet just because one existed on the account (independent of whether that's
    // actually the wallet the user is using) produced a quote for a wallet with a
    // completely different balance than the one just shown in holdings — "swap your
    // 8.85 USDG" followed by "this wallet has 0 USDG." The client only treats a swap as
    // delegated execution when the connected wallet IS the delegated one (see
    // isUsingDelegatedWallet in nock-app.tsx), so the taker here must match that exactly.
    const swapTaker = walletAddress

    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(walletAddress) },
      // Only the recent window of the conversation goes to the model. Seen live: after a
      // few action cards in one chat, gpt-4o-mini — given a long history full of its own
      // "I've prepared a buy..." confirmations — starts REPLAYING that text, fabricating
      // quote numbers from context instead of calling get_swap_quote, so no real card gets
      // built (a fresh chat worked because it had no such history). A recent window keeps
      // it grounded and calling tools; the deterministic command paths below still read the
      // full `messages` array, so exact commands work regardless of window size.
      ...messages.slice(-12).map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.text,
      })),
    ]

    let action: ActionPreview | undefined
    let responseText = ''
    let lastSwapQuote: any = null
    let lastCollateralQuote: StockCollateralQuote | null = null
    let perpsInfoCalled = false
    let lastYieldQuote:
      | Awaited<ReturnType<typeof buildYieldDeposit>>
      | Awaited<ReturnType<typeof buildMarketSupply>>
      | Awaited<ReturnType<typeof buildMarketWithdraw>>
      | null = null
    let bridgeInfo: { link: string; sourceChain: string; destinationChain: string; etaMinutes: number } | undefined

    // ── PRE-MODEL: cross-chain funding IN / cash-out OUT via Houdini ───────────────────
    // IN  : "add/fund/deposit <amt> FROM ethereum/base"  → external USDC → USDG on Robinhood.
    // OUT : "cash out/withdraw/swap <amt> USDG TO ethereum/base" → USDG on Robinhood → USDC.
    // Direction is set by "from <chain>" vs "to <chain>". v1 external asset is USDC. Distinct
    // from perps/yield deposits (USDG already on Robinhood). Builds the preview card; the
    // client signs ONE tx on the sell chain on Confirm (see nock-app routeVia:'houdini').
    // Deliberately excludes "bridge" so the informational get_bridge_info flow is untouched.
    if (houdiniEnabled() && walletAddress && isAddress(walletAddress)) {
      try {
        const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
        const txt = (lastUser?.text || '').trim()
        // "eth chain" is an alias for Ethereum-the-network (as opposed to bare "eth", which
        // below means the ETH TOKEN) — lets "swap to eth chain" resolve the destination chain.
        // `ether\w*` (not a literal "ethereum") tolerates "ether"/"etherium"/typos like
        // "etherum" — a message with the typo used to miss this regex entirely and fall
        // through to the general model, which doesn't know Houdini is an approved
        // integration and would refuse to help with it when named explicitly.
        let chain = /\bbase\b/i.test(txt) ? 'base' : /\b(ether\w*|mainnet|eth\s*chain)\b/i.test(txt) ? 'ethereum' : null
        const fundVerb = /\b(add|fund|deposit|bring|top\s*up)\b/i.test(txt)
        const cashVerb = /\b(cash\s*out|cashout|withdraw|off\s*ramp|take\s*out|send)\b/i.test(txt)
        const swapVerb = /\b(swap|convert|move|transfer|bridge)\b/i.test(txt)
        const usdc = /\busdc\b/i.test(txt)
        const usdg = /\busdg\b/i.test(txt)
        // Bare "eth" (not "ethereum") as the EXTERNAL asset — e.g. "swap 0.01 eth from base
        // to usdg". Requires an explicit chain (below) since ETH also exists natively on
        // Robinhood Chain; without a named external chain this is ambiguous with a normal
        // same-chain swap, which the regular swap agent already handles.
        const eth = /\beth\b/i.test(txt)
        const assetSymbol: 'USDC' | 'ETH' | null = usdc ? 'USDC' : eth ? 'ETH' : null
        // "to/from robinhood(chain)" is an explicit, unambiguous cross-chain signal on its
        // own — the ONLY chain named might be the external one (e.g. "bridge eth to
        // robinhood" names no external chain at all). Checked independently of `chain` so it
        // still resolves direction even when no external chain was mentioned.
        const toRobinhood = /\b(to|onto|into)\s+robinhood(\s*chain)?\b/i.test(txt)
        const fromRobinhood = /\bfrom\s+robinhood(\s*chain)?\b/i.test(txt)
        // Determine direction. A USDC<->USDG conversion is itself unambiguous (USDC lives on
        // Ethereum/Base, USDG on Robinhood), so it maps to a Houdini flow even with no chain
        // named — that's the case that used to fall through to the old bridge deep-link.
        let direction: 'in' | 'out' | null = null
        if (/\busdc\b[\s\S]{0,12}\b(to|into|for|=>|->)\b[\s\S]{0,12}\busdg\b/i.test(txt)) direction = 'in'
        else if (/\busdg\b[\s\S]{0,12}\b(to|into|for|=>|->)\b[\s\S]{0,12}\busdc\b/i.test(txt)) direction = 'out'
        else if (chain && /\bfrom\s+(ether\w*|base|mainnet|eth\s*chain)\b/i.test(txt)) direction = 'in'
        else if (chain && /\b(to|onto|into)\s+(ether\w*|base|mainnet|eth\s*chain)\b/i.test(txt)) direction = 'out'
        else if (toRobinhood) direction = 'in'
        else if (fromRobinhood) direction = 'out'
        else if (chain && fundVerb) direction = 'in'
        else if (chain && cashVerb) direction = 'out'
        else if (chain && swapVerb && usdg) direction = 'out'
        // No external chain named, but the request is unambiguous anyway → default to
        // Ethereum (tell the user they can say "Base"): either a USDC<->USDG conversion
        // (USDC lives on Ethereum/Base), or an explicit "to/from robinhood" mention — both
        // signal cross-chain intent clearly enough that ETH gets this default too here
        // (unlike the plain "chain && ..." rules above, where bare "eth" alone would be
        // ambiguous with a normal same-chain swap).
        let chainDefaulted = false
        if (!chain && direction && (usdg || toRobinhood || fromRobinhood)) { chain = 'ethereum'; chainDefaulted = true }

        if (chain && direction && assetSymbol && (fundVerb || cashVerb || swapVerb || (usdc && usdg))) {
          const chainLabel = chain === 'base' ? 'Base' : 'Ethereum'
          const chainNote = chainDefaulted ? ` (assuming your ${direction === 'in' ? 'USDC' : 'USDC destination'} is on ${chainLabel} — say "Base" to use Base instead)` : ''
          const assetKey = `${chain}:${assetSymbol}`
          // Which Robinhood-side asset this flow moves. Default USDG (fund/cash-out the
          // USDG wallet — the only product for a USDC leg). If the external asset is ETH
          // and the user never said "usdg", this is instead a direct ETH<->ETH bridge that
          // never touches USDG (Houdini supports this natively both ways).
          const robinhoodAsset: RobinhoodAssetKey = usdg ? 'USDG' : assetSymbol === 'ETH' ? 'ETH' : 'USDG'
          const dollarMatch = txt.match(/\$\s*(\d+(?:\.\d+)?)/)
          const m = dollarMatch || txt.match(/(\d+(?:\.\d+)?)\s*(?:usdc|usdg|eth|usd|dollars)?/i)
          let amount = m ? parseFloat(m[1]) : null
          // Houdini enforces a per-transfer minimum (~$5 in practice, up to $10/$25 on some
          // routes). Use a clean $10 floor so the user gets a friendly heads-up instead of a
          // raw API "amount too low" error. Only applies when the SELL side is USDC/USDG,
          // which are ~1:1 with USD — an ETH sell side is in ETH units, so this check doesn't
          // translate; Houdini's own quote call surfaces a real error for a too-small amount.
          const MIN_USD = 10
          // The sell side is in ETH units (not USD) whenever funding-IN sells external ETH,
          // OR cashing-OUT sells Robinhood-native ETH (the ETH<->ETH bridge). A "$" amount
          // there means dollars-WORTH, not literal ETH units — convert using a live price
          // (same feed the portfolio valuation uses) rather than either misreading "$20" as
          // 20 whole ETH (~$37k) or making the user do the math themselves.
          const sellSideIsEth = (direction === 'in' && assetSymbol === 'ETH') || (direction === 'out' && robinhoodAsset === 'ETH')
          let ethPriceNote = ''
          let ethPriceFetchFailed = false
          if (sellSideIsEth && dollarMatch && amount) {
            const ethPrice = (await getReferencePrices()).ETH
            if (ethPrice) {
              const usdAmount = amount
              amount = Math.round((usdAmount / ethPrice) * 1e6) / 1e6
              ethPriceNote = ` (≈ $${usdAmount.toFixed(2)} at $${ethPrice.toFixed(2)}/ETH)`
            } else {
              amount = null // no live price available — fall through to the prompt below
              ethPriceFetchFailed = true
            }
          }
          if (ethPriceFetchFailed) {
            responseText = `I couldn't fetch a live ETH price to convert that right now — give the amount in ETH directly instead, e.g. "${direction === 'in' ? `add 0.01 ETH from ${chain}` : `bridge 0.01 ETH to ${chain}`}".`
          } else if (!amount || amount <= 0) {
            responseText =
              direction === 'in'
                ? `How much would you like to add from ${chainLabel}? Give an amount in ${assetSymbol} (e.g. "add 50 ${assetSymbol} from ${chain}").`
                : `How much ${robinhoodAsset} do you want to ${robinhoodAsset === 'ETH' ? 'bridge' : 'cash out'} to ${chainLabel}? e.g. "${robinhoodAsset === 'ETH' ? `bridge 0.01 ETH to ${chain}` : `cash out 50 USDG to ${assetSymbol} on ${chain}`}".`
          } else if (assetSymbol === 'USDC' && amount < MIN_USD) {
            responseText = `Cross-chain transfers have a $${MIN_USD} minimum. Try $${MIN_USD} or more — e.g. ${
              direction === 'in' ? `"add ${MIN_USD} USDC from ${chain}"` : `"cash out ${MIN_USD} USDG to USDC on ${chain}"`
            }.`
          } else {
            const country =
              request.headers.get('x-vercel-ip-country') || request.headers.get('cf-ipcountry') || request.headers.get('x-country-code') || undefined
            const { asset, best } = await getHoudiniQuote(assetKey, amount, direction, country || undefined, robinhoodAsset)
            const out = best.netAmountOut ?? best.amountOut
            // Dollar value of `out` — NOT the same number as `out` itself for a non-stablecoin
            // side (ETH); falls back to `out` for USDG/USDC, which are ~1:1 with USD anyway.
            const outUsd = best.amountOutUsd ?? out
            // best.eta/best.duration are in SECONDS (confirmed live: a route with
            // duration:600 arrives in ~10 min, not the "~600 min" a direct pass-through
            // would show) — convert properly, floor at "< 1 min" for anything under a minute.
            const etaSec = best.eta ?? best.duration ?? 300
            const etaMin = Math.round(etaSec / 60)
            const etaLabel = etaSec < 60 ? '< 1 min' : `~${etaMin} min`
            // The symbol for whichever side `out` (the amount RECEIVED) represents.
            const outSymbol = direction === 'in' ? robinhoodAsset : asset.symbol
            const outStr = fmtHoudiniAmount(out, outSymbol)
            const sellSymbol = direction === 'in' ? asset.symbol : robinhoodAsset
            const sellLabel = `${fmtHoudiniAmount(amount, sellSymbol)} ${sellSymbol}`
            const headline =
              direction === 'in'
                ? `Add ${sellLabel} from ${chainLabel} → ${outStr} ${robinhoodAsset}`
                : robinhoodAsset === 'ETH'
                  ? `Bridge ${sellLabel} on Robinhood → ${outStr} ${asset.symbol} on ${chainLabel}`
                  : `Cash out ${sellLabel} → ${outStr} ${asset.symbol} on ${chainLabel}`
            const sendLine = direction === 'in' ? `${sellLabel} on ${chainLabel}` : `${sellLabel} on Robinhood`
            const recvLine = direction === 'in' ? `~${outStr} ${robinhoodAsset} on Robinhood` : `~${outStr} ${asset.symbol} on ${chainLabel}`
            const signWhere = direction === 'in' ? chainLabel : 'Robinhood Chain'
            const robinhoodOnRobinhoodText =
              direction === 'in' ? `Brings funds onto Robinhood Chain as ${robinhoodAsset}` : `Sends funds off Robinhood Chain as ${asset.symbol}`
            action = {
              id: `act-${Date.now()}`,
              agent: 'swap',
              action: headline,
              detail: `${robinhoodOnRobinhoodText} via Houdini. You sign one transaction on ${signWhere}; it arrives in ${etaLabel}. The rate is live and may vary slightly at signing.`,
              metrics: [
                { label: 'You send', value: sendLine },
                { label: 'You receive', value: recvLine },
                { label: 'Route', value: best.swapName || 'Houdini' },
                { label: 'ETA', value: etaLabel },
              ],
              status: 'pending',
              outcome:
                direction === 'in'
                  ? { title: `${robinhoodAsset} on Robinhood`, value: `~$${outUsd.toFixed(2)}`, meta: `${outStr} ${robinhoodAsset}`, activityTitle: headline }
                  : { title: `${asset.symbol} on ${chainLabel}`, value: `~$${outUsd.toFixed(2)}`, meta: `${outStr} ${asset.symbol}`, activityTitle: headline },
              routeVia: 'houdini',
              houdiniAssetKey: assetKey,
              houdiniAmount: String(amount),
              houdiniDirection: direction,
              houdiniRobinhoodAsset: robinhoodAsset,
              verified: true,
            } as any
            responseText =
              (direction === 'in'
                ? `Here's your cross-chain funding preview — press Confirm to sign on ${chainLabel} and receive ${robinhoodAsset} on Robinhood.${chainNote}`
                : robinhoodAsset === 'ETH'
                  ? `Here's your bridge preview — press Confirm to sign on Robinhood Chain and receive ${asset.symbol} on ${chainLabel}.${chainNote}`
                  : `Here's your cash-out preview — press Confirm to sign on Robinhood Chain and receive ${asset.symbol} on ${chainLabel}.${chainNote}`) + ethPriceNote
          }
          if (action || responseText) return NextResponse.json({ text: responseText, action, bridgeInfo })
        }
      } catch (e) {
        const msg = (e as Error)?.message
        console.error('[robin] houdini cross-chain backstop failed:', msg)
        return NextResponse.json({ text: `I couldn't set up the cross-chain transfer right now${msg ? `: ${msg}` : '.'}`, bridgeInfo })
      }
    }

    // ── PRE-MODEL FAST PATH for trades ────────────────────────────────────────────────
    // The model (even gpt-4o) is slow + easily confused on trades — e.g. "sell all my nock
    // TOKENS" made it treat "tokens" as a ticker, burning 2-3 min then erroring. When the
    // message is an unambiguous buy/sell of a KNOWN asset (an OFFICIAL stock OR a verified
    // token: ETH/WETH/NOCK), build the quote + card HERE and skip the model loop entirely:
    // near-instant and always right. Stocks route via Uniswap, verified tokens via 0x.
    // Ambiguous cases (e.g. "sell that stock" with no ticker, memecoins, raw addresses)
    // fall through to the model, which handles discovery/context.
    if (walletAddress && isAddress(walletAddress)) {
      try {
        const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
        const fpText = (lastUser?.text || '').trim()
        const verbMatch = fpText.match(/\b(buy|sell)\b/i)
        if (verbMatch) {
          const isBuy = verbMatch[1].toLowerCase() === 'buy'
          const STOP = new Set(['buy', 'sell', 'all', 'full', 'everything', 'entire', 'max', 'my', 'the', 'of', 'with', 'worth', 'usdg', 'usd', 'usdc', 'dollars', 'to', 'for', 'a', 'an', 'stock', 'stocks', 'token', 'tokens', 'tokenized', 'want', 'wanna', 'wan', 'i', 'me', 'now', 'please', 'some', 'that', 'this', 'and', 'swap', 'trade', 'convert'])
          const words = fpText.split(/[^a-zA-Z]+/).filter((w) => /^[a-zA-Z]{1,6}$/.test(w))
          // The ASSET being traded (the non-USDG side): a verified token or an official stock.
          let asset: { kind: 'stock' | 'verified'; symbol: string; address: string; decimals: number; priceUsd: number | null } | null = null
          for (const w of words) {
            const u = w.toUpperCase()
            if (STOP.has(w.toLowerCase()) || u === 'USDG') continue
            if (u in SWAP_TOKENS) { asset = { kind: 'verified', symbol: u, address: SWAP_TOKENS[u].address, decimals: SWAP_TOKENS[u].decimals, priceUsd: null }; break }
            const st = await findStockToken(w).catch(() => null)
            if (st) { asset = { kind: 'stock', symbol: st.symbol, address: st.address, decimals: 18, priceUsd: st.priceUsd }; break }
          }
          if (asset) {
            const dollarMatch = fpText.match(/\$\s*(\d+(?:\.\d+)?)/) || fpText.match(/(\d+(?:\.\d+)?)\s*(?:usdg|usd|dollars)\b/i)
            const wantsAll = /\b(all|full|everything|entire|max)\b/i.test(fpText)
            const bareNum = !dollarMatch && !wantsAll ? fpText.match(/(\d+(?:\.\d+)?)/) : null
            let quoteAmount: string | null = null // asset units for a sell, USDG for a buy
            let fastErr: string | null = null

            if (isBuy) {
              if (dollarMatch) quoteAmount = dollarMatch[1]
              else if (bareNum) quoteAmount = bareNum[1]
              else fastErr = `How much USDG do you want to spend to buy ${asset.symbol}?`
            } else if (wantsAll) {
              const raw = (await getReadClient().readContract({ address: asset.address as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddress as `0x${string}`] })) as bigint
              if (raw > BigInt(0)) quoteAmount = formatUnits(raw, asset.decimals)
              else fastErr = `You don't hold any ${asset.symbol} to sell.`
            } else if (dollarMatch) {
              let price = asset.priceUsd
              if (price == null) { const rp = await getReferencePrices().catch(() => ({} as Record<string, number>)); price = rp[asset.symbol] ?? null }
              if (price == null) { const dx = await getTokenPriceByAddress(asset.address).catch(() => null); price = dx?.priceUsd ?? null }
              if (price && price > 0) quoteAmount = (parseFloat(dollarMatch[1]) / price).toPrecision(8)
              else fastErr = `I couldn't get a live ${asset.symbol} price to size a $${dollarMatch[1]} sell — tell me the amount in ${asset.symbol} units instead.`
            } else if (bareNum) {
              quoteAmount = bareNum[1]
            } else {
              fastErr = `How much ${asset.symbol} do you want to sell? Give an amount, a $ value, or say "all".`
            }

            if (fastErr) {
              responseText = fastErr
            } else if (quoteAmount) {
              const isStock = asset.kind === 'stock'
              const quote = isStock
                ? await fetchUniswapStockQuote({ stockAddress: asset.address, stockSymbol: asset.symbol, direction: isBuy ? 'buy' : 'sell', amount: quoteAmount })
                : await fetchSwapQuote({ fromToken: isBuy ? 'USDG' : asset.symbol, toToken: isBuy ? asset.symbol : 'USDG', amount: quoteAmount, taker: walletAddress })
              if ((quote as any).error) {
                responseText = (quote as any).error
              } else {
                let gateMsg: string | null = null
                if (isStock) {
                  const gate = await getNockGateStatus(walletAddress)
                  if (gate.enabled && !gate.holder) gateMsg = gateMessage(gate, 'the Stock Token Agent')
                }
                if (gateMsg) {
                  responseText = gateMsg
                } else {
                  lastSwapQuote = quote
                  const outcomeValue = await computeQuotedTradeValue(quote)
                  const exceededLimit = await getExceededSpendLimit(walletAddress, outcomeValue)
                  if (exceededLimit !== null) {
                    responseText = `That trade is worth about ${outcomeValue}, which is over your set spend limit of $${exceededLimit} per transaction, so I can't prepare it. You can adjust the limit in Settings.`
                  } else {
                    const headline = isStock
                      ? (isBuy ? `Buy ${quote.toAmount} ${quote.toSymbol} with ${quote.fromAmount} ${quote.fromSymbol}` : `Sell ${quote.fromAmount} ${quote.fromSymbol} for ${quote.toAmount} ${quote.toSymbol}`)
                      : `Swap ${quote.fromAmount} ${quote.fromSymbol} for ${quote.toAmount} ${quote.toSymbol}`
                    action = {
                      id: `act-${Date.now()}`,
                      agent: isStock ? 'stock' : 'swap',
                      action: headline,
                      detail: isStock
                        ? 'This trades at the live Uniswap pool price. A stock token is price exposure only, not share ownership.'
                        : 'This swaps at the live quoted rate.',
                      metrics: [
                        { label: 'You pay', value: `${quote.fromAmount} ${quote.fromSymbol}` },
                        { label: 'You receive', value: `${quote.toAmount} ${quote.toSymbol}` },
                        { label: 'Rate', value: String(quote.exchangeRate) },
                      ],
                      status: 'pending',
                      outcome: { title: `${quote.toSymbol} position`, value: outcomeValue, meta: `${quote.toAmount} ${quote.toSymbol}`, activityTitle: headline },
                      transactionData: quote.transaction,
                      fromToken: quote.fromSymbol,
                      toToken: quote.toSymbol,
                      amount: quote.fromAmount,
                      verified: true,
                      sellTokenAddress: quote.sellTokenAddress,
                      sellTokenDecimals: quote.sellTokenDecimals,
                      sellAmountRaw: (quote as any).sellAmountRaw,
                      ...((quote as any).routeVia ? { routeVia: (quote as any).routeVia } : {}),
                      ...((quote as any).deadlineTimestamp ? { quoteDeadline: (quote as any).deadlineTimestamp } : {}),
                    } as any
                    responseText = isStock
                      ? `Here's the ${isBuy ? 'buy' : 'sell'} preview for ${asset.symbol}, from the live Uniswap price — press Confirm to execute, or Review first. (A first stock trade can need up to three wallet confirmations: two approvals, then the trade.)`
                      : `Here's the ${isBuy ? 'buy' : 'sell'} preview for ${asset.symbol}, from the live quote — press Confirm to execute, or Review first.`
                  }
                }
              }
            }

            if (action || responseText) {
              return NextResponse.json({ text: responseText, action, bridgeInfo })
            }
          }
        }
      } catch (e) {
        console.error('[robin] trade fast-path failed, falling through to model:', e)
      }
    }

    // Loop so the model can chain tool calls within one request — e.g. get_swap_quote
    // to fetch real numbers, then propose_action to build the preview card from them.
    // A single non-looped round (the previous implementation) meant propose_action was
    // never reachable after a data-fetching tool call, so no action card ever appeared.
    for (let round = 0; round < 6; round++) {
      const response = await getOpenAI().chat.completions.create({
        // Upgraded from gpt-4o-mini (2026-07-20): mini was unreliable at tool routing
        // (the whole reason for the many deterministic backstops below) — e.g. it routed
        // "withdraw from my perp account" to the yield path for some phrasings. gpt-4o is
        // far stronger here. Costs more per token but per-conversation cost stays small.
        // Revert to 'gpt-4o-mini' here if cost becomes a concern (backstops still hold).
        model: 'gpt-4o',
        messages: openaiMessages,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: 1024,
      })

      const message = response.choices[0]?.message
      if (!message) break

      if (!message.tool_calls || message.tool_calls.length === 0) {
        responseText = message.content || ''
        break
      }

      openaiMessages.push(message as any)

      for (const toolCall of message.tool_calls) {
        const functionName = (toolCall as any).function.name
        const functionArgs = JSON.parse((toolCall as any).function.arguments)
        // Diagnostic trail for "what did the model actually do" questions — confirmed
        // necessary when a missing propose_action call was undiagnosable from logs.
        console.log('[robin] tool call:', functionName, JSON.stringify(functionArgs).slice(0, 200))

        let result: unknown

        if (functionName === 'propose_action') {
          const input = functionArgs as ProposeActionInput

          // Perps gating — the chokepoint where a real perps order would be born. Three
          // gates, in order: (1) jurisdiction, (2) the live-execution flag, (3) the execution
          // adapter's own guards. A restricted region is refused even before the flag, so the
          // honest regional message shows regardless of whether perps is live anywhere.
          if (input.agent === 'perps') {
            const geo = await resolvePerpsGeo(request)

            if (geo.source !== 'unknown' && !geo.allowed) {
              // Known restricted region (e.g. US/Canada) — regulatory, not a bug.
              result = {
                error: `Perps are not available in the user's region (${geo.country}). This is a regulatory restriction (CFTC in the US, CSA in Canada), not a technical limit — do NOT propose the action. Tell the user plainly, and offer what Nock does support for them instead: tokenized stocks for real market exposure, token swaps, and yield.`,
              }
            } else if (!PERPS_ENABLED) {
              // Not live yet — present the real data, promise nothing we can't do.
              result = {
                error: 'Perps execution is not live yet (final compliance sign-off pending). Present the live Lighter market data from get_perps_info and tell the user that opening a position is launching soon for eligible regions — do not propose the action.',
              }
            } else if (!geo.allowed) {
              // Flag on, but region undetermined — cannot confirm eligibility, so refuse.
              result = {
                error: "Could not verify the user's region, so a perps position can't be opened right now. Present the market data and ask them to try again shortly — do not propose the action.",
              }
            } else if (!input.perps) {
              result = { error: "Missing structured perps order parameters. Call get_perps_info first, then include the 'perps' object in propose_action." }
            } else if (input.perps.fundsAction === 'deposit' || input.perps.fundsAction === 'withdraw') {
              // FUNDS MOVEMENT (deposit / withdraw) — build a preview card; the client
              // executes it on Confirm (deposit = on-chain USDG -> escrow; withdraw =
              // browser-signed Lighter withdraw). Same geofence as trading (gated above).
              if (!(Number(input.perps.amountUsdg) > 0)) {
                result = { error: 'A positive amountUsdg is required for a deposit/withdraw.' }
              } else {
                // Build the card deterministically (do NOT rely on the model providing
                // metrics/outcome — a funds card without metrics crashed the render).
                const amt = Number(input.perps.amountUsdg)
                const isDep = input.perps.fundsAction === 'deposit'
                const amtStr = `$${amt.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                action = {
                  id: `act-${Date.now()}`,
                  agent: 'perps',
                  action: isDep ? `Deposit ${amtStr} into perps account` : `Withdraw ${amtStr} to your wallet`,
                  detail: isDep
                    ? `Moves ${amtStr} USDG from your wallet into your perps account as margin.`
                    : `Returns ${amtStr} of free margin from your perps account to your wallet (settles in a few minutes).`,
                  metrics: [
                    { label: 'Amount', value: amtStr, positive: true },
                    { label: isDep ? 'From' : 'From', value: isDep ? 'Your wallet' : 'Perps account' },
                    { label: 'To', value: isDep ? 'Perps account' : 'Your wallet' },
                  ],
                  status: 'pending',
                  outcome: {
                    title: isDep ? `Deposited ${amtStr} to perps` : `Withdrawing ${amtStr} to wallet`,
                    value: amtStr,
                    meta: isDep ? 'margin added' : 'settling to wallet',
                    activityTitle: isDep ? 'Perps deposit' : 'Perps withdrawal',
                  },
                  routeVia: 'perps',
                  perps: {
                    fundsAction: input.perps.fundsAction,
                    amountUsdg: input.perps.amountUsdg,
                  },
                } as any
                result = { status: 'preview_ready' }
              }
            } else if (!input.perps.reduceOnly && !(input.perps.marginUsd > 0 && input.perps.leverage >= 1)) {
              result = { error: 'To OPEN a perps position, marginUsd (>0) and leverage (>=1) are required. To CLOSE one, set reduceOnly: true.' }
            } else {
              // Eligible region + live flag + valid params: build a PREVIEW CARD. Do NOT
              // execute here — a real, leveraged order must never fire just from the model
              // proposing it (that caused accidental double-fills on retries). The order is
              // placed only when the user clicks Confirm, which POSTs these params to the
              // client-side signer (or the executor fallback). This mirrors the swap/stock
              // flow: preview → Confirm → execute. `routeVia: 'perps'` is the discriminator
              // the client's Confirm handler branches on. reduceOnly => close the position.
              action = {
                id: `act-${Date.now()}`,
                agent: 'perps',
                action: input.action,
                detail: input.detail,
                metrics: input.metrics,
                status: 'pending',
                outcome: input.outcome,
                routeVia: 'perps',
                perps: {
                  symbol: input.perps.symbol,
                  side: input.perps.side,
                  marginUsd: input.perps.marginUsd,
                  leverage: input.perps.leverage,
                  markPrice: input.perps.markPrice,
                  reduceOnly: input.perps.reduceOnly ?? false,
                  reducePct: input.perps.reducePct,
                  maxSlippageBps: 50,
                },
              } as any
              result = { status: 'preview_ready' }
            }

            openaiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })
            continue
          }

          // $NOCK tier gate (dormant until NOCK_TOKEN_ADDRESS is set): the Stock
          // Token Agent is premium per the one-pager — trades routed through
          // Uniswap (whichever agent label the model picked) and collateral
          // actions all pass through here, so this is the chokepoint. Yield and
          // swaps stay free.
          if (input.agent === 'stock' || lastSwapQuote?.routeVia === 'uniswap-v4') {
            const gate = await getNockGateStatus(walletAddress)
            if (gate.enabled && !gate.holder) {
              result = { error: gateMessage(gate, 'the Stock Token Agent') }
              openaiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })
              continue
            }
          }

          // A swap preview is only real if it's backed by a transaction from a quote
          // fetched in THIS turn — otherwise the model can (and did, in testing) build a
          // preview card from numbers it just remembered/recomputed from earlier chat
          // history, which looks identical but has no transaction to actually execute.
          const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')

          // Seen in prod: the model can silently substitute a different token
          // than what the user asked for (user said "swap to NOCK", model quietly built a
          // preview for USDG instead, since it had suggested USDG as a fallback earlier in
          // the conversation) — with no error, no confirmation, nothing to catch in a
          // prompt-only fix. This is a hard backstop: if the user's own latest message
          // contains a word that looks like a token symbol but doesn't match either side of
          // the quote actually being proposed, refuse and force the model to check with the
          // user instead of guessing. A false positive here just costs an extra clarifying
          // question — an acceptable price for never silently executing the wrong trade.
          const { mismatchedTokenWord, stockImpersonatorWord, directionMismatch } =
            (input.agent === 'swap' || input.agent === 'stock')
              ? await validateQuotedTrade(lastSwapQuote, lastUserMessage?.text)
              : {}

          // A stock-agent action can be backed by EITHER a trade quote or a collateral
          // quote (borrow/repay) — exactly one is set (the quote handlers null the other).
          const isCollateralAction = input.agent === 'stock' && lastCollateralQuote !== null && !lastSwapQuote?.transaction

          if ((input.agent === 'swap' || input.agent === 'stock') && !lastSwapQuote?.transaction && !isCollateralAction) {
            result = {
              error: 'No fresh quote available. Call get_swap_quote (for a trade) or get_stock_borrow_quote/get_stock_repay_quote (for collateral actions) first, then call propose_action again with its real numbers. Do not reuse or recompute numbers from earlier in the conversation.',
            }
          } else if (directionMismatch) {
            result = { error: directionMismatch }
          } else if (stockImpersonatorWord) {
            result = {
              error: `The user asked about ${stockImpersonatorWord}, which is an official Robinhood stock token, but this quote does not involve that symbol's official contract address. Do not propose this trade. Call get_stock_tokens with symbol "${stockImpersonatorWord}" to get the official address, quote against that exact address, and try again. Never trade a same-ticker lookalike contract for a stock request.`,
            }
          } else if (input.agent === 'yield' && !(lastYieldQuote && 'transaction' in lastYieldQuote)) {
            // Same hard backstop as swap above — a preview card must be backed by a real,
            // just-fetched transaction, never invented or reused numbers. If
            // get_yield_deposit_quote already ran this turn and came back with an error
            // (deposits closed), relay that instead of this generic message.
            result = {
              error: lastYieldQuote && 'error' in lastYieldQuote
                ? lastYieldQuote.error
                : 'No live quote available. Call get_yield_deposit_quote (or get_yield_withdraw_quote) with a specific USDG amount and market first, then call propose_action again with its real numbers.',
            }
          } else if (mismatchedTokenWord) {
            result = {
              error: `The user's message mentions "${mismatchedTokenWord}", which doesn't match either side of this quote (${lastSwapQuote.fromSymbol} -> ${lastSwapQuote.toSymbol}). Do not propose this swap. Either "${mismatchedTokenWord}" is a token that needs to be looked up (call get_trending_tokens for it) and confirmed with the user first, or you misread which token the user meant — ask them to clarify exactly which token before calling get_swap_quote or propose_action again. Never substitute a different token than what the user actually named without their explicit confirmation.`,
            }
          } else {
            // The model was putting the raw token quantity into outcome.value as if it
            // were a dollar figure (a position of "4,672.36 NOCK" showed up as "$4,672.36",
            // a ~700x overstatement that then got added straight into the portfolio total).
            // Never trust the model's own arithmetic for a dollar amount — compute it here
            // from the verified price of the token actually being sold, which is real data
            // we already have. If we don't have a verified price for the sell side (e.g.
            // selling an unverified memecoin), say so plainly instead of guessing.
            let outcomeValue = input.outcome.value
            if (isCollateralAction && lastCollateralQuote) {
              // Borrow: the risk number is the USDG borrowed. Repay/close: the USDG
              // repaid (or the collateral's oracle value when only withdrawing).
              const q = lastCollateralQuote
              const usdNum = parseFloat(q.usdgAmount)
              outcomeValue = usdNum > 0
                ? `$${usdNum.toFixed(2)}`
                : `$${(parseFloat(q.collateralDelta) * q.oraclePriceUsd).toFixed(2)}`
            } else if ((input.agent === 'swap' || input.agent === 'stock') && lastSwapQuote?.transaction) {
              outcomeValue = await computeQuotedTradeValue(lastSwapQuote)
            } else if (input.agent === 'yield' && lastYieldQuote && 'transaction' in lastYieldQuote) {
              const prices = await getReferencePrices()
              const usdgPrice = prices.USDG ?? 1
              const amountNum = parseFloat(lastYieldQuote.amount)
              outcomeValue = !isNaN(amountNum) ? `$${(amountNum * usdgPrice).toFixed(2)}` : 'Value unavailable'
            }

            // Vault Agent's real spend-limit check — an additional, app-level ceiling on
            // top of the existing global Privy policy (see lib/db/schema.ts's
            // walletGuardrails table). Fires here, before propose_action ever returns a
            // card to the user, not just at execution time — matches the doc's "Vault
            // Agent confirms the action falls inside your set limits" happening as part
            // of the preview step, not after.
            // Withdrawals are exempt: they bring the user's own money BACK to their
            // wallet — a $1 spend limit must never be able to trap a $100 position.
            const isWithdrawal =
              input.agent === 'yield' && lastYieldQuote && 'direction' in lastYieldQuote && lastYieldQuote.direction === 'withdraw'
            // Repaying debt (or reclaiming posted collateral) brings the user's own
            // position back — the spend limit must never trap someone in a loan,
            // the same reasoning as the yield-withdrawal exemption.
            const isRepay = isCollateralAction && lastCollateralQuote?.kind === 'stock-repay'
            let guardrailViolation: string | undefined
            if ((input.agent === 'swap' || input.agent === 'stock' || input.agent === 'yield') && !isWithdrawal && !isRepay) {
              const exceededLimit = await getExceededSpendLimit(walletAddress, outcomeValue)
              if (exceededLimit !== null) {
                guardrailViolation = `This action is worth about ${outcomeValue}, which is over the user's set spend limit of $${exceededLimit} per transaction. Do not propose this action. Tell the user plainly it was blocked by their own spend limit, and that they can raise it from Settings if they want to allow it.`
              }
            }

            if (guardrailViolation) {
              result = { error: guardrailViolation }
              openaiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })
              continue
            }

            // The card headline and metrics come from the SAME quote the transaction
            // is built from. Caught live: the model framed a sell as a buy while the
            // attached transaction did the opposite. Display and execution can no
            // longer diverge for quoted trades.
            // Collateral cards are fully server-bound like quoted trades — headline,
            // metrics, and the executable steps all come from the same live quote.
            const collateralBound = isCollateralAction && lastCollateralQuote
              ? (() => {
                  const q = lastCollateralQuote!
                  const isBorrow = q.kind === 'stock-borrow'
                  const closing = !isBorrow && parseFloat(q.collateralDelta) > 0
                  const headline = isBorrow
                    ? `Borrow ${q.usdgAmount} USDG against ${q.collateralDelta !== '0' ? `${q.collateralDelta} ` : 'your posted '}${q.stockSymbol}`
                    : parseFloat(q.usdgAmount) > 0
                      ? (closing ? `Repay ${q.usdgAmount} USDG and reclaim ${q.collateralDelta} ${q.stockSymbol}` : `Repay ${q.usdgAmount} USDG of the ${q.stockSymbol} loan`)
                      : `Withdraw ${q.collateralDelta} ${q.stockSymbol} collateral`
                  const metrics = isBorrow
                    ? [
                        { label: 'Collateral', value: `${q.collateralDelta !== '0' ? q.collateralDelta : 'already posted'} ${q.stockSymbol}` },
                        { label: 'You receive', value: `${q.usdgAmount} USDG` },
                        { label: 'Liquidation price', value: q.liquidationPriceUsdAfter ? `$${q.liquidationPriceUsdAfter.toFixed(2)}` : '—' },
                      ]
                    : [
                        { label: 'You repay', value: `${q.usdgAmount} USDG` },
                        { label: 'Collateral returned', value: q.collateralDelta !== '0' ? `${q.collateralDelta} ${q.stockSymbol}` : 'stays posted' },
                        { label: 'Debt after', value: `$${q.debtAfterUsd.toFixed(2)}` },
                      ]
                  return { headline, metrics }
                })()
              : null

            const isQuotedTrade = (input.agent === 'swap' || input.agent === 'stock') && lastSwapQuote?.transaction
            const tradeVerb = input.agent === 'stock'
              ? (String(lastSwapQuote?.fromSymbol).toUpperCase() === 'USDG' ? 'Buy' : 'Sell')
              : 'Swap'
            const boundAction = collateralBound
              ? collateralBound.headline
              : isQuotedTrade
              ? (tradeVerb === 'Buy'
                  ? `Buy ${lastSwapQuote.toAmount} ${lastSwapQuote.toSymbol} with ${lastSwapQuote.fromAmount} ${lastSwapQuote.fromSymbol}`
                  : tradeVerb === 'Sell'
                    ? `Sell ${lastSwapQuote.fromAmount} ${lastSwapQuote.fromSymbol} for ${lastSwapQuote.toAmount} ${lastSwapQuote.toSymbol}`
                    : `Swap ${lastSwapQuote.fromAmount} ${lastSwapQuote.fromSymbol} for ${lastSwapQuote.toAmount} ${lastSwapQuote.toSymbol}`)
              : input.action
            const boundMetrics = collateralBound
              ? collateralBound.metrics
              : isQuotedTrade
              ? [
                  { label: 'You pay', value: `${lastSwapQuote.fromAmount} ${lastSwapQuote.fromSymbol}` },
                  { label: 'You receive', value: `${lastSwapQuote.toAmount} ${lastSwapQuote.toSymbol}` },
                  { label: 'Rate', value: String(lastSwapQuote.exchangeRate) },
                ]
              : input.metrics

            action = {
              id: `act-${Date.now()}`,
              agent: input.agent,
              action: boundAction,
              detail: input.detail,
              metrics: boundMetrics,
              status: 'pending',
              outcome: { ...input.outcome, value: outcomeValue },
              ...((input.agent === 'swap' || input.agent === 'stock') && lastSwapQuote?.transaction ? {
                transactionData: lastSwapQuote.transaction,
                fromToken: lastSwapQuote.fromSymbol,
                toToken: lastSwapQuote.toSymbol,
                amount: lastSwapQuote.fromAmount,
                verified: lastSwapQuote.verified !== false,
                sellTokenAddress: lastSwapQuote.sellTokenAddress,
                sellTokenDecimals: lastSwapQuote.sellTokenDecimals,
                sellAmountRaw: lastSwapQuote.sellAmountRaw,
                // Stock trades execute through the Uniswap Universal Router (Permit2
                // settlement), not the 0x router — the client picks its executor off this.
                ...(lastSwapQuote.routeVia ? { routeVia: lastSwapQuote.routeVia } : {}),
                ...(lastSwapQuote.deadlineTimestamp ? { quoteDeadline: lastSwapQuote.deadlineTimestamp } : {}),
              } : {}),
              ...(input.agent === 'yield' && lastYieldQuote && 'transaction' in lastYieldQuote ? {
                transactionData: lastYieldQuote.transaction,
                fromToken: 'USDG',
                toToken: 'vaultSymbol' in lastYieldQuote
                  ? lastYieldQuote.vaultSymbol
                  : `${lastYieldQuote.market} market`,
                amount: lastYieldQuote.amount,
                verified: true,
                sellTokenAddress: lastYieldQuote.assetAddress,
                sellTokenDecimals: lastYieldQuote.assetDecimals,
                // 'withdraw' makes handleLoose skip the sell-token balance/approval
                // pre-flight — nothing leaves the wallet on a withdrawal.
                direction: 'direction' in lastYieldQuote ? lastYieldQuote.direction : 'supply',
              } : {}),
              ...(isCollateralAction && lastCollateralQuote ? {
                // Multi-step Morpho action. transactionData carries the LAST step so
                // the shared pipeline's gas math and null-guard work unchanged; the
                // client executes collateralSteps in order via executeCollateralSequence.
                transactionData: lastCollateralQuote.steps[lastCollateralQuote.steps.length - 1],
                collateralSteps: lastCollateralQuote.steps,
                approval: lastCollateralQuote.approval,
                routeVia: 'morpho-collateral',
                fromToken: lastCollateralQuote.approval?.tokenSymbol ?? lastCollateralQuote.stockSymbol,
                toToken: lastCollateralQuote.kind === 'stock-borrow' ? 'USDG' : `${lastCollateralQuote.stockSymbol} loan`,
                // amount drives the client's balance pre-flight: the approval amount is
                // what actually leaves the wallet. '0' (no approval — borrow-only or
                // withdraw-only) makes that check a no-op; the address must still be a
                // real ERC20 for the balanceOf read, so USDG stands in. formatUnits,
                // never float math: Number()/10**18 on an 18-decimal amount rounded a
                // full-balance collateral post UP by one wei, and the pre-flight then
                // demanded more than the wallet holds ("Not enough TSLA ...709 vs
                // ...708" — seen live).
                amount: lastCollateralQuote.approval
                  ? formatUnits(BigInt(lastCollateralQuote.approval.amountRaw), lastCollateralQuote.approval.tokenDecimals)
                  : '0',
                verified: true,
                sellTokenAddress: lastCollateralQuote.approval?.tokenAddress ?? '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
                sellTokenDecimals: lastCollateralQuote.approval?.tokenDecimals ?? 6,
              } : {}),
            } as any
            result = { status: 'preview_ready' }
          }

        } else if (functionName === 'get_wallet_holdings') {
          if (!walletAddress || !isAddress(walletAddress)) {
            result = { error: 'No wallet connected. Ask the user to connect their wallet first.' }
          } else {
            try {
              console.log('[robin] Fetching balances for:', walletAddress)
              // Collateral positions ride along — without them, stock posted as
              // collateral silently vanishes from the answer (seen live: a borrow
              // made TSLA "disappear" and the stated portfolio total drop, when the
              // user still owned it and owed 2 USDG against it).
              const [balances, collateralPositions, lighter] = await Promise.all([
                fetchWalletBalances(walletAddress),
                getStockBorrowPositions(walletAddress).catch(() => []),
                getLighterPortfolio(walletAddress).catch(() => null),
              ])
              console.log('[robin] Balances fetched:', balances)
              // The total is computed HERE, never left to the model's arithmetic —
              // seen live: items summing to ~$14.3 presented as "approximately $8.37".
              const walletUsd = balances.reduce((s, b) => s + (b.usdValue ?? 0), 0)
              const netCollateralUsd = collateralPositions.reduce((s, p) => s + (p.collateralValueUsd - p.borrowedUsd), 0)
              // Perps (Lighter) equity — the USDG deposited as margin plus unrealized PnL.
              // It left the wallet on deposit, so it's not double-counted with wallet USDG;
              // open positions are leveraged exposure and are listed, not added to the total.
              const perpsEquityUsd = lighter?.hasAccount ? lighter.equityUsd : 0
              const perps = lighter?.hasAccount
                ? { balanceUsd: lighter.collateralUsd, availableUsd: lighter.availableUsd, equityUsd: lighter.equityUsd, positions: lighter.positions }
                : null
              result = {
                balances,
                collateralPositions,
                perps,
                totalPortfolioUsd: Number((walletUsd + netCollateralUsd + perpsEquityUsd).toFixed(2)),
                note: [
                  'Live on-chain balances with live USD reference prices.',
                  collateralPositions.length > 0
                    ? 'collateralPositions is stock the user OWNS but has posted as loan collateral on Morpho — it is NOT in the wallet balances above and MUST be listed as its own line ("posted as collateral"), with the debt owed and liquidation price next to it.'
                    : '',
                  perps && (perps.positions.length > 0 || perps.balanceUsd > 0)
                    ? `perps is the user's Lighter perpetual-futures account (separate from the wallet). ALWAYS surface it: state the perps balance (balanceUsd, the USDG margin deposited there) as its own line, and list EACH open position in perps.positions with its side (long/short), symbol, notional (notionalUsd), leverage, and unrealized PnL (unrealizedPnlUsd, + or −). This balance is already folded into totalPortfolioUsd (as equity = margin + unrealized PnL); the position notionals are leveraged exposure and are NOT separately added.`
                    : '',
                  'State totalPortfolioUsd as the total portfolio value EXACTLY as given — never compute your own total.',
                ].filter(Boolean).join(' '),
              }
            } catch (err) {
              console.error('[robin] Balance fetch error:', err)
              result = { error: 'Could not fetch balances from the chain. The RPC may be temporarily unavailable.' }
            }
          }

        } else if (functionName === 'get_bridge_info') {
          bridgeInfo = {
            link: 'https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum',
            sourceChain: 'ethereum',
            destinationChain: 'robinhood-chain',
            etaMinutes: 10,
          }
          result = {
            ...bridgeInfo,
            instructions: 'This is the official Arbitrum bridge (Robinhood Chain is an Arbitrum Orbit L2). Bridge into the same wallet address already connected — funds show up automatically once confirmed.',
          }

        } else if (functionName === 'get_trending_tokens') {
          const { symbol } = functionArgs as { symbol?: string }
          try {
            // Hard server-side guard: an official stock symbol NEVER goes through the
            // unverified token search, no matter what the model intended — seen live:
            // a "how much TSLA do I hold" question routed here and surfaced three
            // same-ticker impersonator contracts for the user to pick from.
            const officialStock = symbol ? await findStockToken(symbol).catch(() => null) : null
            if (officialStock) {
              result = {
                tokens: [officialStock],
                note: `"${officialStock.symbol}" is an OFFICIAL Robinhood stock token, so the unverified community-token list was deliberately not searched — same-ticker impersonator contracts exist there. Use this verified contract address (${officialStock.address}) for anything ${officialStock.symbol}-related: balance checks via get_token_balance, quotes via get_swap_quote. Present it as price exposure, not share ownership.`,
              }
            } else {
              const tokens = symbol ? await findTokensBySymbol(symbol) : await getTrendingTokens()
              result = {
                tokens,
                warning: 'These are unverified community/memecoin tokens on Robinhood Chain, not vetted by Robinhood. Anyone can deploy a token with any name — real impersonator tokens exist. Confirm the exact contract address with the user before quoting.',
              }
            }
          } catch (err) {
            result = { error: 'Could not reach token lookup service. Try again in a moment.' }
          }

        } else if (functionName === 'get_token_balance') {
          const { address } = functionArgs as { address?: string }
          if (!walletAddress || !isAddress(walletAddress)) {
            result = { error: 'No wallet connected. Ask the user to connect their wallet first.' }
          } else if (!address || !isAddress(address)) {
            result = { error: 'A valid contract address is required. Look it up via get_trending_tokens first if you only have a symbol.' }
          } else {
            try {
              const [balance, priceInfo] = await Promise.all([
                fetchArbitraryTokenBalance(walletAddress as `0x${string}`, address as `0x${string}`),
                getTokenPriceByAddress(address).catch(() => null),
              ])
              const amountNum = parseFloat(balance.amount.replace(/,/g, ''))
              const usdValue = priceInfo?.priceUsd != null && !isNaN(amountNum) ? amountNum * priceInfo.priceUsd : null
              result = {
                symbol: balance.symbol,
                amount: balance.amount,
                usdValue,
                note: 'Real on-chain balance for this specific contract address. usdValue is null if no live price was available — say so plainly rather than guessing a value.',
              }
            } catch (err) {
              console.error('[robin] get_token_balance error:', err)
              result = { error: 'Could not read balance for that address from the chain. Double-check the address is correct.' }
            }
          }

        } else if (functionName === 'get_swap_quote') {
          const { fromToken: fromTokenRaw, toToken: toTokenRaw, amount: amountArg, amountUsd } = functionArgs as {
            fromToken?: string; toToken?: string; amount?: string; amountUsd?: string
          }

          // Resolve a stock SYMBOL (e.g. "TSLA") to its OFFICIAL contract address up front.
          // Otherwise the model guesses addresses (trying same-ticker impersonators) — slow
          // (multiple failed quote round-trips) and wrong — and both the dollar-conversion
          // and the stock/Uniswap routing below key off the official address. Verified
          // symbols (USDG/ETH/WETH/NOCK) and raw 0x addresses are left untouched.
          let fromToken = fromTokenRaw
          let toToken = toTokenRaw
          if (fromToken && !isAddress(fromToken) && !(fromToken.toUpperCase() in SWAP_TOKENS)) {
            const st = await findStockToken(fromToken).catch(() => null)
            if (st) fromToken = st.address
          }
          if (toToken && !isAddress(toToken) && !(toToken.toUpperCase() in SWAP_TOKENS)) {
            const st = await findStockToken(toToken).catch(() => null)
            if (st) toToken = st.address
          }

          // Dollar-denominated sells are converted here, deterministically, at the
          // live price — the model reading "$2 worth of ETH" as 2 ETH (a ~$7,000
          // misread caught in testing) is exactly the class of arithmetic it must
          // never do itself.
          let amount = amountArg
          let usdConversionError: string | undefined
          if (!amount && amountUsd && fromToken) {
            const usd = parseFloat(String(amountUsd).replace(/[$,]/g, ''))
            if (isNaN(usd) || usd <= 0) {
              usdConversionError = 'amountUsd must be a positive dollar number.'
            } else {
              const prices = await getReferencePrices()
              let unitPrice = prices[fromToken.toUpperCase()]
              if (unitPrice === undefined && isAddress(fromToken)) {
                const stocks = await getStockTokens().catch(() => [])
                const stockMatch = stocks.find((s) => s.address.toLowerCase() === fromToken.toLowerCase())
                if (stockMatch?.priceUsd != null) unitPrice = stockMatch.priceUsd
                if (unitPrice === undefined) {
                  const dex = await getTokenPriceByAddress(fromToken).catch(() => null)
                  if (dex?.priceUsd != null) unitPrice = dex.priceUsd
                }
              }
              if (unitPrice === undefined || unitPrice <= 0) {
                usdConversionError = `No live price available for ${fromToken} to convert a dollar amount — ask the user for the amount in token units instead.`
              } else {
                amount = (usd / unitPrice).toPrecision(6)
              }
            }
          }

          // "Sell all / max" resolution. Seen in prod: for "sell all TSLA" the model
          // passes the literal word "all" as amount (never resolving it to a balance),
          // and parseUnits("all") then throws → the whole quote fails. "Sell all" is a
          // common request, so resolve it here, deterministically, to the wallet's exact
          // on-chain balance of the sell-side token — full precision from formatUnits (no
          // rounding UP past what's held, which would fail at execution), no thousands
          // separators. ERC-20s only; selling the entire native ETH is refused because
          // gas must be left over.
          const ALL_WORDS = /^(all|max|maximum|everything|entire|full|100%)$/i
          let allResolveError: string | undefined
          if (amount && ALL_WORDS.test(amount.trim()) && fromToken) {
            const up = fromToken.toUpperCase()
            let tokenAddr: string | undefined
            if (isAddress(fromToken)) tokenAddr = fromToken
            else if (up in SWAP_TOKENS) tokenAddr = SWAP_TOKENS[up].address
            amount = undefined // clear the unparseable word; set below only on success
            if (tokenAddr && tokenAddr.toLowerCase() === NATIVE_ETH_ADDRESS.toLowerCase()) {
              allResolveError = "Selling your entire ETH isn't possible — some must stay to pay gas. Tell me a specific amount of ETH to sell."
            } else if (!tokenAddr) {
              allResolveError = `To sell your full ${fromToken} balance I need its token, but couldn't resolve it — give a specific amount instead.`
            } else if (!walletAddress || !isAddress(walletAddress)) {
              allResolveError = 'No wallet connected. Ask the user to connect their wallet first.'
            } else {
              try {
                const client = getReadClient()
                const [raw, decimals] = await Promise.all([
                  client.readContract({ address: tokenAddr as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [walletAddress as `0x${string}`] }),
                  client.readContract({ address: tokenAddr as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }),
                ])
                if ((raw as bigint) > BigInt(0)) {
                  amount = formatUnits(raw as bigint, decimals as number)
                } else {
                  allResolveError = `You don't hold any ${up in SWAP_TOKENS ? up : fromToken} to sell.`
                }
              } catch {
                allResolveError = 'Could not read your balance to size a full sell — try a specific amount.'
              }
            }
          }

          // Seen in prod: despite the prompt explicitly saying to ask for an
          // amount before calling this tool, the model sometimes calls it anyway with a
          // fabricated amount (e.g. defaulting to "100 USDG") when the user never gave
          // one — occasionally producing a real 0x API error, and always a quote for a
          // size the user never asked for. A prompt instruction alone wasn't reliable
          // enough to prevent this. Hard backstop: if no user message anywhere in this
          // conversation contains a digit OUTSIDE of a contract address, the model cannot
          // possibly have a real amount to work with, so refuse and force it to actually
          // ask. Contract addresses (0x + 40 hex chars) are stripped first — confirmed
          // this guard originally false-positived because an address is full of digits.
          // "Sell all" carries no digit but is a real, resolved amount — exempt it.
          const hasUserSpecifiedAmount = amount != null || messages.some(
            (m) => m.role === 'user' && /\d/.test(m.text.replace(/0x[a-fA-F0-9]{40}/g, '')),
          )

          if (allResolveError) {
            result = { error: allResolveError }
          } else if (!hasUserSpecifiedAmount) {
            result = {
              error: "The user has not specified a swap amount anywhere in this conversation. Do not guess or default to any amount (e.g. 100, 1, 0.01) — ask the user exactly how much they want to swap, then call this tool again once they answer with a specific number.",
            }
          } else if (usdConversionError) {
            result = { error: usdConversionError }
          } else if (!fromToken || !toToken || !amount) {
            result = { error: 'fromToken, toToken, and either amount or amountUsd are required.' }
          } else if (!walletAddress || !isAddress(walletAddress)) {
            // 0x requires a taker address, which is the connected wallet — without one
            // the quote 400s with a cryptic validation error the model then misreads.
            result = { error: 'No wallet connected. Ask the user to connect their wallet first — a quote needs their address as the taker.' }
          } else {
            const supportedSymbols = Object.keys(SWAP_TOKENS).join(', ')
            try {
              // Verified stock tokens route through Uniswap v4 directly — 0x refuses
              // tokenized equities at its API layer (BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE),
              // but the underlying pools are public and liquid. Address-match against
              // the registry only: a stock is only ever a stock when it's the OFFICIAL
              // contract, so impersonators still go down the normal unverified-token path.
              const stocks = await getStockTokens().catch(() => [])
              const stockOnBuySide = isAddress(toToken) ? stocks.find((s) => s.address.toLowerCase() === toToken.toLowerCase()) : undefined
              const stockOnSellSide = isAddress(fromToken) ? stocks.find((s) => s.address.toLowerCase() === fromToken.toLowerCase()) : undefined

              let quote
              if (stockOnBuySide || stockOnSellSide) {
                const counterSide = stockOnBuySide ? fromToken : toToken
                if (String(counterSide).toUpperCase() !== 'USDG') {
                  quote = { error: 'Stock tokens currently trade against USDG only. Quote the other side as USDG (the user can swap into USDG first if needed).' } as any
                } else {
                  quote = await fetchUniswapStockQuote({
                    stockAddress: (stockOnBuySide ?? stockOnSellSide)!.address,
                    stockSymbol: (stockOnBuySide ?? stockOnSellSide)!.symbol,
                    direction: stockOnBuySide ? 'buy' : 'sell',
                    amount,
                  })
                }
              } else {
                quote = await fetchSwapQuote({
                  fromToken,
                  toToken,
                  amount,
                  taker: swapTaker,
                })
              }
              if (!quote.error) {
                lastSwapQuote = quote
                lastCollateralQuote = null
              }
              result = quote.error
                ? { error: quote.error, supportedTokens: supportedSymbols }
                : { ...quote, supportedTokens: supportedSymbols }
            } catch {
              result = { error: 'Failed to reach the swap quoting services. Try again in a moment.', supportedTokens: supportedSymbols }
            }
          }

        } else if (functionName === 'get_yield_options') {
          try {
            const [vaults, markets] = await Promise.all([
              getYieldOptions().catch(() => []),
              getMorphoMarketData(),
            ])
            result = {
              vault: vaults[0] ?? null,
              vaultNote: 'The Steakhouse USDG vault (Robinhood Earn) — real live data, but currently closed to direct deposits from external wallets.',
              markets,
              marketsNote: 'Real, live Morpho lending markets — the exact same three markets the Robinhood Earn vault itself lends into (confirmed on-chain), but open to any wallet permissionlessly. supplyApyPct is derived live from the on-chain interest rate model, never guessed. Lending here is direct: the user picks ONE market (unlike the vault, where a curator spreads across all three), and withdrawals are capped by availableLiquidityUsd at any given moment. Present APY, collateral type, and that liquidity caveat honestly.',
            }
          } catch (err) {
            console.error('[robin] get_yield_options error:', err)
            result = { error: 'Could not read live vault data from the chain. Try again in a moment.' }
          }

        } else if (functionName === 'get_yield_deposit_quote') {
          const { amount, market } = functionArgs as { amount?: string; market?: string }

          // Same hard backstop as get_swap_quote above — never let the model default or
          // guess a deposit amount, this is real money.
          const hasUserSpecifiedAmount = messages.some(
            (m) => m.role === 'user' && /\d/.test(m.text.replace(/0x[a-fA-F0-9]{40}/g, '')),
          )

          if (!hasUserSpecifiedAmount) {
            result = {
              error: 'The user has not specified a deposit amount anywhere in this conversation. Do not guess or default to any amount — ask the user exactly how much USDG they want to deposit, then call this tool again once they answer with a specific number.',
            }
          } else if (!amount) {
            result = { error: 'amount is required.' }
          } else if (!walletAddress || !isAddress(walletAddress)) {
            result = { error: 'No wallet connected. Ask the user to connect their wallet first.' }
          } else if (market && !(market in MORPHO_MARKETS)) {
            result = { error: `Unknown market "${market}". Valid markets: ${Object.keys(MORPHO_MARKETS).join(', ')}.` }
          } else {
            try {
              const quote = market
                ? await buildMarketSupply(walletAddress, amount, market as MorphoMarketKey)
                : await buildYieldDeposit(walletAddress, amount)
              lastYieldQuote = quote
              result = quote
            } catch (err) {
              console.error('[robin] get_yield_deposit_quote error:', err)
              result = { error: 'Could not read live deposit availability from the chain. Try again in a moment.' }
            }
          }

        } else if (functionName === 'get_yield_positions') {
          if (!walletAddress || !isAddress(walletAddress)) {
            result = { error: 'No wallet connected. Ask the user to connect their wallet first.' }
          } else {
            try {
              const positions = await getUserMarketPositions(walletAddress)
              result = {
                positions,
                note: positions.length === 0
                  ? 'This wallet has no USDG supplied to any Morpho market right now.'
                  : 'Real on-chain lending positions, read live. suppliedUsd already includes accrued interest.',
              }
            } catch (err) {
              console.error('[robin] get_yield_positions error:', err)
              result = { error: 'Could not read lending positions from the chain. Try again in a moment.' }
            }
          }

        } else if (functionName === 'get_yield_withdraw_quote') {
          const { amount, market } = functionArgs as { amount?: string; market?: string }

          const hasUserSpecifiedAmount = messages.some(
            (m) => m.role === 'user' && /\d/.test(m.text.replace(/0x[a-fA-F0-9]{40}/g, '')),
          )

          if (!hasUserSpecifiedAmount) {
            result = {
              error: 'The user has not specified a withdrawal amount anywhere in this conversation. Do not guess or default to any amount — ask the user exactly how much USDG they want to withdraw, then call this tool again once they answer with a specific number.',
            }
          } else if (!amount || !market) {
            result = { error: 'amount and market are both required.' }
          } else if (!(market in MORPHO_MARKETS)) {
            result = { error: `Unknown market "${market}". Valid markets: ${Object.keys(MORPHO_MARKETS).join(', ')}.` }
          } else if (!walletAddress || !isAddress(walletAddress)) {
            result = { error: 'No wallet connected. Ask the user to connect their wallet first.' }
          } else {
            try {
              const quote = await buildMarketWithdraw(walletAddress, amount, market as MorphoMarketKey)
              lastYieldQuote = quote
              result = quote
            } catch (err) {
              console.error('[robin] get_yield_withdraw_quote error:', err)
              result = { error: 'Could not build a withdrawal quote from the chain. Try again in a moment.' }
            }
          }

        } else if (functionName === 'get_stock_tokens') {
          const { symbol } = functionArgs as { symbol?: string }
          try {
            if (symbol) {
              const token = await findStockToken(symbol)
              result = token
                ? {
                    token,
                    note: 'Official Robinhood stock token, verified on-chain against the official issuer. priceUsd is the live on-chain trading price (24/7 — it can drift from the official market close). Price exposure only, not share ownership. To trade it, call get_swap_quote with this exact address (trades against USDG, routed through Uniswap directly).',
                  }
                : { error: `Robinhood doesn't issue an official stock token with the symbol "${symbol}". Do not look for it among unverified tokens — tell the user it isn't available as an official stock token.` }
            } else {
              const tokens = await getStockTokens()
              result = {
                tokens: tokens.slice(0, 25),
                totalCount: tokens.length,
                note: 'Official Robinhood stock tokens only, each verified on-chain against the official issuer, sorted by 24h volume. Prices are live on-chain trading prices (24/7). Price exposure, not share ownership — no dividends or voting rights. Tradeable against USDG via get_swap_quote with the exact address.',
              }
            }
          } catch (err) {
            console.error('[robin] get_stock_tokens error:', err)
            result = { error: 'Could not load the verified stock token registry. Try again in a moment.' }
          }

        } else if (functionName === 'get_stock_collateral_info') {
          try {
            const [markets, positions] = await Promise.all([
              getStockCollateralMarketData(),
              walletAddress && isAddress(walletAddress)
                ? getStockBorrowPositions(walletAddress).catch(() => [])
                : Promise.resolve([]),
            ])
            result = markets.length === 0
              ? { markets: [], note: 'No Morpho market currently accepts an official stock token as collateral. Say so plainly — do not invent borrowing options.' }
              : {
                  markets,
                  userPositions: positions,
                  note: 'Live on-chain Morpho markets where an OFFICIAL stock token is the collateral and USDG is borrowed. oraclePriceUsd is the price liquidations use (can differ slightly from the DEX trading price). lltvPct is the hard ceiling: debt above collateralValue × LLTV is liquidatable. To actually borrow or repay, call get_stock_borrow_quote / get_stock_repay_quote with the user’s exact amounts, then propose_action.',
                }
          } catch (err) {
            console.error('[robin] get_stock_collateral_info error:', err)
            result = { error: 'Could not load stock collateral markets from the chain. Try again in a moment.' }
          }

        } else if (functionName === 'get_stock_borrow_quote' || functionName === 'get_stock_repay_quote') {
          const { stockSymbol, borrowUsd, collateralAmount, repayUsd } = functionArgs as {
            stockSymbol?: string; borrowUsd?: string; collateralAmount?: string; repayUsd?: string
          }
          if (!walletAddress || !isAddress(walletAddress)) {
            result = { error: 'No wallet connected. Ask the user to connect their wallet first.' }
          } else if (!stockSymbol) {
            result = { error: 'stockSymbol is required.' }
          } else {
            try {
              const quote = functionName === 'get_stock_borrow_quote'
                ? (borrowUsd
                    ? await buildStockBorrow(walletAddress, stockSymbol, borrowUsd, collateralAmount)
                    : { error: 'borrowUsd is required — ask the user for the exact USDG amount to borrow, never guess.' })
                : (repayUsd
                    ? await buildStockRepay(walletAddress, stockSymbol, repayUsd === 'all' ? 'all' : repayUsd)
                    : { error: "repayUsd is required — an exact USDG amount or 'all'." })
              // Same silent-substitution backstop quoted trades have: if the user's
              // own message names an official stock symbol, the collateral quote must
              // be for that stock — the model must never quietly borrow against a
              // different position than the one the user asked about.
              let symbolMismatch: string | undefined
              if (!('error' in quote)) {
                const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user')
                if (lastUserMsg) {
                  const namedAll: string[] = []
                  for (const w of extractCandidateTokenWords(lastUserMsg.text)) {
                    if (await findStockToken(w).catch(() => null)) namedAll.push(w)
                  }
                  if (namedAll.length > 0 && !namedAll.includes(quote.stockSymbol.toUpperCase())) {
                    // Ticker/common-word collisions must not block legit quotes:
                    // several official tickers are everyday words ("how much would
                    // it COST to borrow against my Apple" names Costco; "borrow some
                    // COIN against my Tesla" names Coinbase). A named symbol only
                    // counts as the-stock-the-user-means if the wallet actually
                    // holds it or has a position in it — a real substitution (user
                    // holds NVDA, said NVDA, quote is TSLA) is still caught.
                    const [holdings, loanPositions] = await Promise.all([
                      fetchWalletBalances(walletAddress as `0x${string}`).catch(() => []),
                      getStockBorrowPositions(walletAddress).catch(() => []),
                    ])
                    const ownable = new Set<string>([
                      ...holdings.filter((b) => parseFloat(String(b.amount).replace(/[<,]/g, '')) > 0).map((b) => b.symbol.toUpperCase()),
                      ...loanPositions.map((p) => p.stockSymbol.toUpperCase()),
                    ])
                    const named = namedAll.filter((w) => ownable.has(w))
                    if (named.length > 0 && !named.includes(quote.stockSymbol.toUpperCase())) {
                      symbolMismatch = `The user's message names ${named.join('/')}, which they actually hold, but this quote is for ${quote.stockSymbol}. Never substitute a different stock position. Quote again with the symbol the user actually named, or ask them to clarify which position they mean.`
                    }
                  }
                }
              }

              if ('error' in quote) {
                result = { error: quote.error }
              } else if (symbolMismatch) {
                result = { error: symbolMismatch }
              } else {
                lastCollateralQuote = quote
                // A quoted trade and a quoted collateral action are mutually exclusive
                // intents within one turn — whichever tool ran last wins the card.
                lastSwapQuote = null
                result = {
                  ...quote,
                  steps: quote.steps.map((s) => s.label), // model sees the plan, never raw calldata
                  note: `Real executable quote. ${quote.kind === 'stock-borrow' ? `LTV after this borrow: ${quote.ltvUtilizationAfterPct.toFixed(0)}% of the liquidation ceiling; liquidation if ${quote.stockSymbol} oracle price falls to $${quote.liquidationPriceUsdAfter?.toFixed(2)}. State both numbers when proposing.` : 'Repaying reduces risk and is exempt from the spend limit.'} The user may see ${quote.steps.length + (quote.approval ? 1 : 0)} wallet confirmations (approval + each step) — mention that. Now call propose_action with agent 'stock' using these exact numbers.`,
                }
              }
            } catch (err) {
              console.error('[robin] collateral quote error:', err)
              result = { error: 'Could not build the collateral quote from the chain. Try again in a moment.' }
            }
          }

        } else if (functionName === 'get_perps_info') {
          const { symbol } = functionArgs as { symbol?: string }
          perpsInfoCalled = true
          try {
            result = await getPerpsMarkets(symbol)
          } catch (err) {
            console.error('[robin] get_perps_info error:', err)
            result = { error: 'Could not reach the Lighter market data API. Try again in a moment.' }
          }

        } else if (functionName === 'get_vault_status') {
          if (!walletAddress || !isAddress(walletAddress)) {
            result = { error: 'No wallet connected. Ask the user to connect their wallet first.' }
          } else {
            try {
              const wallet = await getWalletByAddress(walletAddress)
              const [guardrails, loanPositions] = await Promise.all([
                wallet ? getGuardrails(wallet.id) : Promise.resolve({ maxUsdPerTransaction: null }),
                getStockBorrowPositions(walletAddress).catch(() => []),
              ])
              result = {
                maxUsdPerTransaction: guardrails.maxUsdPerTransaction,
                note: guardrails.maxUsdPerTransaction === null
                  ? 'No spend limit is set — any swap or yield deposit amount can be proposed.'
                  : `Proposed swaps and yield deposits over $${guardrails.maxUsdPerTransaction} will be declined before a preview is ever shown.`,
                openLoans: loanPositions.map((p) => ({
                  stockSymbol: p.stockSymbol,
                  debtUsd: p.borrowedUsd,
                  ltvUtilizationPct: Math.round(p.ltvUtilizationPct),
                  liquidationPriceUsd: p.liquidationPriceUsd,
                  status: p.ltvUtilizationPct >= 80 ? 'AT RISK — flag this to the user' : 'healthy',
                })),
                loanMonitoring: 'Open loans are checked on every app load and by a daily server-side sweep; a loan at 80%+ of its liquidation ceiling surfaces in Needs Attention.',
                nockGate: await getNockGateStatus(walletAddress).then((g) => ({
                  tierSystemActive: g.enabled,
                  note: g.enabled
                    ? (g.holder
                        ? `Premium agents unlocked — this wallet holds ${g.balance} $NOCK (${g.requiredBalance} required).`
                        : `Premium agents (Stock Token, Perps) require holding ${g.requiredBalance} $NOCK; this wallet holds ${g.balance}. Swaps and yield are free.`)
                    : 'All agents are currently free — the $NOCK tier system activates when the token launches.',
                })),
                automaticProtections: [
                  'Every proposed action is built from a fresh, live quote — never a reused or guessed number.',
                  'A swap or deposit amount is never invented — Robin always asks the user for an exact amount first.',
                  'If the user mentions a token that does not match the current quote, the action is refused rather than silently substituted.',
                  'New stock-collateral borrows are capped below the liquidation ceiling with a built-in safety buffer.',
                ],
              }
            } catch (err) {
              console.error('[robin] get_vault_status error:', err)
              result = { error: 'Could not read guardrail settings. Try again in a moment.' }
            }
          }

        } else {
          result = { error: `Unknown tool: ${functionName}` }
        }

        openaiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        })
      }
    }

    const fallback =
      "I'm not sure how to help with that. Try asking me what you hold, to put idle funds to work, swap tokens, open a perps position, or deposit into a vault."

    // Deterministic command path — the model (gpt-4o-mini) has proven unreliable at
    // chaining quote -> propose_action for withdrawals, and a user unable to reach
    // their own supplied funds is the worst failure this app can have. If the user's
    // message is an unambiguous lend/withdraw command and no quote was built this
    // turn, build it directly — no model cooperation needed at all.
    if (!action && !(lastYieldQuote && 'transaction' in lastYieldQuote) && walletAddress && isAddress(walletAddress)) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const match = lastUser?.text.match(
        /\b(withdraw|lend|deposit|supply)\s+\$?([\d,.]+)\s*(?:usdg)?\s+(?:from|to|into)\s+(?:the\s+)?(usde|syrupusdg|spusdg)\b/i,
      )
      if (match) {
        const [, verb, rawAmount, rawMarket] = match
        const marketKey = (Object.keys(MORPHO_MARKETS) as MorphoMarketKey[]).find(
          (k) => k.toLowerCase() === rawMarket.toLowerCase(),
        )
        if (marketKey) {
          try {
            const quote = verb.toLowerCase() === 'withdraw'
              ? await buildMarketWithdraw(walletAddress, rawAmount.replace(/,/g, ''), marketKey)
              : await buildMarketSupply(walletAddress, rawAmount.replace(/,/g, ''), marketKey)
            if ('transaction' in quote) {
              lastYieldQuote = quote
            } else {
              responseText = quote.error
            }
          } catch (err) {
            console.error('[robin] deterministic yield command failed:', err)
          }
        }
      }
    }

    // Deterministic SWAP command path — same reliability story as the yield one
    // above, seen live on the very first message of a session: "swap 5 usdg to eth"
    // answered with no quote fetched and no card. An unambiguous swap command
    // between two VERIFIED tokens gets its quote built directly; the swap synthesis
    // below then turns it into a card with all the usual guards. Anything fuzzier
    // (memecoins, stocks, dollar-denominated) still goes through the model, which
    // has the tools to disambiguate.
    if (!action && !lastSwapQuote?.transaction && walletAddress && isAddress(walletAddress)) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const m = lastUser?.text.match(
        /\b(?:swap|convert)\s+([\d,.]+)\s*([a-z]{2,10})\s+(?:to|for|into)\s+([a-z]{2,10})\b/i,
      )
      if (m) {
        const [, rawAmount, rawFrom, rawTo] = m
        const from = Object.keys(SWAP_TOKENS).find((s) => s.toLowerCase() === rawFrom.toLowerCase())
        const to = Object.keys(SWAP_TOKENS).find((s) => s.toLowerCase() === rawTo.toLowerCase())
        if (from && to && from !== to) {
          try {
            const quote = await fetchSwapQuote({
              fromToken: from,
              toToken: to,
              amount: rawAmount.replace(/,/g, ''),
              taker: walletAddress,
            })
            if (quote.transaction) {
              lastSwapQuote = quote
            } else if (quote.error) {
              responseText = quote.error
            }
          } catch (err) {
            console.error('[robin] deterministic swap command failed:', err)
          }
        }
      }
    }

    // Deterministic "sell/swap ALL my <token>" path. "Sell all" should sell the exact full
    // held quantity — but two things broke that: (1) the displayed balance is rounded
    // (0.001152622 shows as 0.001153), so quoting the display amount OVER-sells and reverts,
    // and (2) you can't sell 100% of native ETH because you still need ETH for gas. So read
    // the EXACT raw balance on-chain here and, for ETH, leave a gas reserve. Verified
    // SWAP_TOKENS only (ETH/WETH/USDG/NOCK); anything else falls through to the model.
    if (!action && !lastSwapQuote?.transaction && walletAddress && isAddress(walletAddress)) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const sellAll = (lastUser?.text ?? '').match(
        /\b(?:sell|swap|convert)\s+all\s+(?:(?:of\s+)?my\s+)?([a-z]{2,10})(?:\s+(?:to|for|into)\s+([a-z]{2,10}))?/i,
      )
      if (sellAll) {
        const fromSym = sellAll[1].toUpperCase()
        const toSym = (sellAll[2] || 'USDG').toUpperCase()
        const fromTok = SWAP_TOKENS[fromSym]
        if (fromTok && fromSym !== toSym) {
          try {
            const client = getReadClient()
            let raw: bigint
            if (fromTok.address.toLowerCase() === NATIVE_ETH_ADDRESS.toLowerCase()) {
              raw = await client.getBalance({ address: walletAddress as `0x${string}` })
              // Gas reserve: can't sell 100% of the native token you pay gas in. ~0.0002
              // ETH headroom (real swap gas seen ~0.00004; keep a safe buffer for drift).
              const GAS_RESERVE = BigInt('200000000000000')
              raw = raw > GAS_RESERVE ? raw - GAS_RESERVE : BigInt(0)
            } else {
              raw = (await client.readContract({
                address: fromTok.address as `0x${string}`,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [walletAddress as `0x${string}`],
              })) as bigint
            }
            // Truncate to 6 decimals. The card shows and the client's balance pre-flight
            // re-parses a 6dp amount; the full-precision balance rounds UP at 6dp (e.g.
            // 3305.3107577… → 3305.310758), which then exceeds the real balance and the
            // swap fails "not enough". Rounding DOWN keeps the amount ≤ balance (sub-6dp
            // dust left behind is negligible).
            if (fromTok.decimals > 6) {
              // 10^(decimals-6) as a bigint, built via string to avoid the ** operator
              // (which the TS target transpiles to Math.pow and breaks on bigint).
              const scale = BigInt('1' + '0'.repeat(fromTok.decimals - 6))
              raw = (raw / scale) * scale
            }
            if (raw > BigInt(0)) {
              const quote = await fetchSwapQuote({
                fromToken: fromSym,
                toToken: toSym,
                amount: formatUnits(raw, fromTok.decimals),
                taker: walletAddress,
              })
              if (quote.transaction) lastSwapQuote = quote
              else if (quote.error) responseText = quote.error
            } else {
              responseText = `You don't have any ${fromSym} available to sell right now${fromSym === 'ETH' ? ' after reserving a little for gas' : ''}.`
            }
          } catch (err) {
            console.error('[robin] deterministic sell-all failed:', err)
          }
        }
      }
    }

    // Deterministic STOCK-REPAY / close command path — the highest-stakes reliability
    // gap of all: failing to build a repay card traps a user's own collateral. Seen
    // live: gpt-4o-mini read "repay all to TSLA" as a swap and built no card, leaving the
    // user unable to close their loan. If the latest message is an unambiguous repay /
    // close / reclaim intent for a stock the user actually has a position in, build the
    // quote directly; the collateral synthesis below then turns it into a card. buildStock-
    // Repay handles both partial (an amount) and full ('all' — repays the exact live debt
    // AND returns the collateral), including the zero-debt "just reclaim collateral" case.
    if (!action && !lastCollateralQuote && walletAddress && isAddress(walletAddress)) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const text = lastUser?.text ?? ''
      if (/\b(repay|close|pay\s*off|reclaim|settle)\b/i.test(text)) {
        try {
          const positions = await getStockBorrowPositions(walletAddress)
          const named = positions.find((p) => new RegExp(`\\b${p.stockSymbol}\\b`, 'i').test(text))
          const target = named ?? (positions.length === 1 ? positions[0] : undefined)
          if (target) {
            const amtMatch = text.match(/\$?\s*(\d[\d,.]*)/)
            // 'all' unless the user gave a specific number and didn't also say all/everything/close.
            const full = !amtMatch || /\b(all|everything|entire|full|in\s*full|close|pay\s*off)\b/i.test(text)
            const repayArg = full ? 'all' : amtMatch![1].replace(/,/g, '')
            const quote = await buildStockRepay(walletAddress, target.stockSymbol, repayArg)
            if (!('error' in quote)) {
              lastCollateralQuote = quote
              lastSwapQuote = null
            } else {
              responseText = quote.error
            }
          }
        } catch (err) {
          console.error('[robin] deterministic repay command failed:', err)
        }
      }
    }

    // Deterministic card synthesis — in practice the model sometimes builds a
    // real yield quote (get_yield_deposit_quote / get_yield_withdraw_quote succeeded,
    // a genuine transaction exists) but then never calls propose_action, leaving the
    // user with no card to execute and no way to move their money. Those quote tools
    // are only ever called because the user explicitly asked to lend or withdraw, so
    // when a real quote exists and the model failed to produce the card, build it
    // server-side from the quote's own verified numbers. The model's cooperation is
    // no longer on the critical path for users reaching their funds.
    if (!action && lastYieldQuote && 'transaction' in lastYieldQuote && 'direction' in lastYieldQuote) {
      const q = lastYieldQuote
      const isW = q.direction === 'withdraw'
      const amountNum = parseFloat(q.amount)
      const valueStr = !isNaN(amountNum) ? `$${amountNum.toFixed(2)}` : 'Value unavailable'

      // Same spend-limit rule as the propose_action path: applies to money leaving
      // the wallet (supply), never to withdrawals returning the user's own funds.
      let blockedByLimit = false
      if (!isW && walletAddress && !isNaN(amountNum)) {
        const wallet = await getWalletByAddress(walletAddress)
        const guardrails = wallet ? await getGuardrails(wallet.id) : { maxUsdPerTransaction: null }
        if (guardrails.maxUsdPerTransaction !== null && amountNum > guardrails.maxUsdPerTransaction) {
          blockedByLimit = true
          responseText = `That's about ${valueStr}, which is over your set spend limit of $${guardrails.maxUsdPerTransaction} per transaction, so I can't prepare it. You can adjust the limit in Settings.`
        }
      }

      if (!blockedByLimit) {
        action = {
          id: `act-${Date.now()}`,
          agent: 'yield',
          action: isW ? `Withdraw ${q.amount} USDG from ${q.market} market` : `Lend ${q.amount} USDG to ${q.market} market`,
          detail: isW
            ? `Withdraws your supplied USDG (plus accrued interest stays until fully withdrawn) from the Morpho ${q.market} market back to your wallet.`
            : `Lends directly into the Morpho ${q.market} market at a live APY of ${q.supplyApyPct.toFixed(2)}%. Withdrawals depend on market liquidity.`,
          metrics: [
            { label: isW ? 'Amount withdrawn' : 'Amount lent', value: `${q.amount} USDG` },
            { label: 'Market', value: q.market },
            { label: isW ? 'Type' : 'Live APY', value: isW ? 'Withdrawal' : `${q.supplyApyPct.toFixed(2)}%` },
          ],
          status: 'pending',
          outcome: {
            title: isW ? 'USDG back in wallet' : `${q.market} lending position`,
            value: valueStr,
            meta: `${q.amount} USDG`,
            activityTitle: isW ? `Withdrew ${q.amount} USDG from ${q.market} market` : `Lent ${q.amount} USDG to ${q.market} market`,
          },
          ...( {
            transactionData: q.transaction,
            fromToken: 'USDG',
            toToken: `${q.market} market`,
            amount: q.amount,
            verified: true,
            sellTokenAddress: q.assetAddress,
            sellTokenDecimals: q.assetDecimals,
            direction: q.direction,
          } as object),
        } as any
        responseText = `Here's the ${isW ? 'withdrawal' : 'lending'} preview, built from live on-chain numbers. Press Confirm on the card to execute it, or Review to check the details first.`
      }
    }

    // Same failure mode as the yield synthesis above, seen live for stock buys: a
    // real Uniswap quote existed, the reply told the user to "press the Confirm
    // button on the action card" — but propose_action was never called, so no card
    // existed and the user was stuck until they started a fresh chat. When the model
    // leaves a fresh quoted trade cardless, build the card server-side from the
    // quote's own verified numbers, under exactly the same guards propose_action
    // enforces (shared helpers — the two paths cannot drift).
    if (!action && lastSwapQuote?.transaction) {
      // Same $NOCK gate as propose_action — synthesis must not become the way
      // around the tier system.
      if (lastSwapQuote.routeVia === 'uniswap-v4') {
        const gate = await getNockGateStatus(walletAddress)
        if (gate.enabled && !gate.holder) {
          return NextResponse.json({
            text: `Stock trading is a premium agent unlocked by holding at least ${gate.requiredBalance} $NOCK (this wallet holds ${gate.balance}). Swaps and yield stay free — or acquire $NOCK to unlock the Stock Token Agent.`,
            action: undefined,
            bridgeInfo,
          })
        }
      }
      const lastUserMessage = [...messages].reverse().find((m: any) => m.role === 'user')
      const guards = await validateQuotedTrade(lastSwapQuote, lastUserMessage?.text)
      if (!guards.mismatchedTokenWord && !guards.stockImpersonatorWord && !guards.directionMismatch) {
        const outcomeValue = await computeQuotedTradeValue(lastSwapQuote)
        const exceededLimit = await getExceededSpendLimit(walletAddress, outcomeValue)
        if (exceededLimit !== null) {
          responseText = outcomeValue.toLowerCase().includes('unavailable')
            ? `I couldn't confirm this trade's dollar value (an unpriced token on both sides), and you have a $${exceededLimit} per-transaction spend limit set — so I won't prepare it. Raise or remove the limit in Settings to allow unpriced trades.`
            : `That trade is worth about ${outcomeValue}, which is over your set spend limit of $${exceededLimit} per transaction, so I can't prepare it. You can adjust the limit in Settings.`
        } else {
          const isStock = lastSwapQuote.routeVia === 'uniswap-v4'
          const isBuy = isStock && String(lastSwapQuote.fromSymbol).toUpperCase() === 'USDG'
          const headline = isStock
            ? (isBuy
                ? `Buy ${lastSwapQuote.toAmount} ${lastSwapQuote.toSymbol} with ${lastSwapQuote.fromAmount} ${lastSwapQuote.fromSymbol}`
                : `Sell ${lastSwapQuote.fromAmount} ${lastSwapQuote.fromSymbol} for ${lastSwapQuote.toAmount} ${lastSwapQuote.toSymbol}`)
            : `Swap ${lastSwapQuote.fromAmount} ${lastSwapQuote.fromSymbol} for ${lastSwapQuote.toAmount} ${lastSwapQuote.toSymbol}`
          action = {
            id: `act-${Date.now()}`,
            agent: isStock ? 'stock' : 'swap',
            action: headline,
            detail: isStock
              ? `This trades at the live Uniswap pool price. A stock token is price exposure only, not share ownership.`
              : `This swaps at the live quoted rate.${lastSwapQuote.verified === false ? ' The token is UNVERIFIED — anyone can deploy a token with any name; scam/rug risk is real.' : ''}`,
            metrics: [
              { label: 'You pay', value: `${lastSwapQuote.fromAmount} ${lastSwapQuote.fromSymbol}` },
              { label: 'You receive', value: `${lastSwapQuote.toAmount} ${lastSwapQuote.toSymbol}` },
              { label: 'Rate', value: String(lastSwapQuote.exchangeRate) },
            ],
            status: 'pending',
            outcome: {
              title: `${lastSwapQuote.toSymbol} position`,
              value: outcomeValue,
              meta: `${lastSwapQuote.toAmount} ${lastSwapQuote.toSymbol}`,
              activityTitle: headline,
            },
            ...( {
              transactionData: lastSwapQuote.transaction,
              fromToken: lastSwapQuote.fromSymbol,
              toToken: lastSwapQuote.toSymbol,
              amount: lastSwapQuote.fromAmount,
              verified: lastSwapQuote.verified !== false,
              sellTokenAddress: lastSwapQuote.sellTokenAddress,
              sellTokenDecimals: lastSwapQuote.sellTokenDecimals,
              // EXACT sell-side wei — without this the client falls back to parsing the
              // display `amount` (rounded to 6dp), which on a full-balance "sell all" rounds
              // UP past the real balance and trips a false "not enough". The other two card
              // builders (fast-path, propose_action) already thread this; this deterministic
              // synthesis path was the one that dropped it.
              sellAmountRaw: lastSwapQuote.sellAmountRaw,
              ...(lastSwapQuote.routeVia ? { routeVia: lastSwapQuote.routeVia } : {}),
              ...(lastSwapQuote.deadlineTimestamp ? { quoteDeadline: lastSwapQuote.deadlineTimestamp } : {}),
            } as object),
          } as any
          responseText = `Here's the trade preview, built from the live quote. Press Confirm on the card to execute it, or Review to check the details first.`
        }
      }
    }

    // Collateral quotes get the same cardless-quote synthesis as swaps and yield —
    // a borrow/repay quote only exists because the user asked to act, so a missing
    // propose_action call must not leave them stuck without a card.
    if (!action && lastCollateralQuote) {
      const collateralGate = await getNockGateStatus(walletAddress)
      if (collateralGate.enabled && !collateralGate.holder) {
        return NextResponse.json({
          text: `Stock collateral actions are part of the premium Stock Token Agent, unlocked by holding at least ${collateralGate.requiredBalance} $NOCK (this wallet holds ${collateralGate.balance}). Swaps and yield stay free.`,
          action: undefined,
          bridgeInfo,
        })
      }
      const q = lastCollateralQuote
      const isBorrow = q.kind === 'stock-borrow'
      const usdNum = parseFloat(q.usdgAmount)
      const valueStr = usdNum > 0 ? `$${usdNum.toFixed(2)}` : `$${(parseFloat(q.collateralDelta) * q.oraclePriceUsd).toFixed(2)}`
      const exceededLimit = isBorrow ? await getExceededSpendLimit(walletAddress, valueStr) : null
      if (exceededLimit !== null) {
        responseText = `That borrow is worth about ${valueStr}, which is over your set spend limit of $${exceededLimit} per transaction, so I can't prepare it. You can adjust the limit in Settings.`
      } else {
        const closing = !isBorrow && parseFloat(q.collateralDelta) > 0
        const headline = isBorrow
          ? `Borrow ${q.usdgAmount} USDG against ${q.collateralDelta !== '0' ? `${q.collateralDelta} ` : 'your posted '}${q.stockSymbol}`
          : usdNum > 0
            ? (closing ? `Repay ${q.usdgAmount} USDG and reclaim ${q.collateralDelta} ${q.stockSymbol}` : `Repay ${q.usdgAmount} USDG of the ${q.stockSymbol} loan`)
            : `Withdraw ${q.collateralDelta} ${q.stockSymbol} collateral`
        action = {
          id: `act-${Date.now()}`,
          agent: 'stock',
          action: headline,
          detail: isBorrow
            ? `Posts the ${q.stockSymbol} as collateral on Morpho and borrows USDG against it at ${q.borrowApyPct.toFixed(2)}% APY. The collateral stays yours and comes back when the debt is repaid. Liquidation if the ${q.stockSymbol} oracle price falls to $${q.liquidationPriceUsdAfter?.toFixed(2)}.`
            : `Repays the Morpho loan${closing ? ` and returns the posted ${q.stockSymbol} collateral to your wallet` : ''}.`,
          metrics: isBorrow
            ? [
                { label: 'Collateral', value: `${q.collateralDelta !== '0' ? q.collateralDelta : 'already posted'} ${q.stockSymbol}` },
                { label: 'You receive', value: `${q.usdgAmount} USDG` },
                { label: 'Liquidation price', value: q.liquidationPriceUsdAfter ? `$${q.liquidationPriceUsdAfter.toFixed(2)}` : '—' },
              ]
            : [
                { label: 'You repay', value: `${q.usdgAmount} USDG` },
                { label: 'Collateral returned', value: q.collateralDelta !== '0' ? `${q.collateralDelta} ${q.stockSymbol}` : 'stays posted' },
                { label: 'Debt after', value: `$${q.debtAfterUsd.toFixed(2)}` },
              ],
          status: 'pending',
          outcome: {
            title: isBorrow ? `USDG borrowed against ${q.stockSymbol}` : `${q.stockSymbol} loan ${q.debtAfterUsd === 0 ? 'closed' : 'reduced'}`,
            value: valueStr,
            meta: isBorrow ? `${q.usdgAmount} USDG` : `debt now $${q.debtAfterUsd.toFixed(2)}`,
            activityTitle: headline,
          },
          ...( {
            transactionData: q.steps[q.steps.length - 1],
            collateralSteps: q.steps,
            approval: q.approval,
            routeVia: 'morpho-collateral',
            fromToken: q.approval?.tokenSymbol ?? q.stockSymbol,
            toToken: isBorrow ? 'USDG' : `${q.stockSymbol} loan`,
            amount: q.approval ? formatUnits(BigInt(q.approval.amountRaw), q.approval.tokenDecimals) : '0',
            verified: true,
            sellTokenAddress: q.approval?.tokenAddress ?? '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
            sellTokenDecimals: q.approval?.tokenDecimals ?? 6,
          } as object),
        } as any
        responseText = `Here's the ${isBorrow ? 'borrow' : 'repayment'} preview, built from live on-chain numbers. Press Confirm on the card to execute it, or Review to check the details first.`
      }
    }

    // Deterministic perps-data backstop — seen live: asked "i want to test some
    // perps", the model skipped get_perps_info entirely and INVENTED markets
    // (BTC quoted at $25,000 against a real $64,882 mark). Any perps-intent
    // message that ends the turn without the real tool having run gets its reply
    // replaced with live Lighter data, formatted here from the same numbers the
    // tool returns — the model cannot be the source of market data.
    if (!action && !perpsInfoCalled) {
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
      // Managing perps FUNDS or POSITIONS (withdraw / deposit / add funds / balance /
      // close) is NOT a market-data question — the backstop must not hijack those replies
      // with a market list (seen live: "withdraw $5 from perpetual" got a markets dump).
      const isFundsOrPositionIntent =
        lastUser && /\b(withdraw|withdrawal|deposit|add funds|take out|cash out|balance|close|reduce|my (position|short|long)|how much)\b/i.test(lastUser.text)
      // Both sides must look perps-shaped: the user asked about perps AND the
      // model's reply talks perps (i.e. it answered the topic without the tool).
      // A passing mention ("forget perps, what do I hold") keeps its real answer.
      if (
        lastUser && !isFundsOrPositionIntent &&
        /\bperps?\b|\bperpetuals?\b|\bfutures\b|\bfunding rate/i.test(lastUser.text) &&
        /perp|futures|leverage|funding|mark price/i.test(responseText)
      ) {
        try {
          const { markets } = await getPerpsMarkets()
          if (markets.length > 0) {
            const lines = markets.slice(0, 5).map((m, i) =>
              `${i + 1}. **${m.asset}**: mark $${m.markPrice.toLocaleString('en-US', { maximumFractionDigits: m.markPrice < 1 ? 6 : 2 })}, funding ${m.fundingRatePctHourly != null ? `${m.fundingRatePctHourly.toFixed(4)}%/hr` : 'n/a'}, 24h volume $${Math.round(m.dailyVolumeUsd).toLocaleString('en-US')}${m.maxLeverage != null ? `, up to ${m.maxLeverage}x` : ''}`,
            )
            responseText = `Here are the top live perps markets on Lighter right now:\n\n${lines.join('\n')}\n\nThese are real, live numbers. ${PERPS_ENABLED ? 'Opening a position is live for eligible regions — just tell me the market, side, size, and leverage.' : 'Opening a position is launching soon for eligible regions — for now this is informational.'}`
          }
        } catch (err) {
          console.error('[robin] deterministic perps backstop failed:', err)
        }
      }
    }

    // Deterministic perps-FUNDS backstop — gpt-4o-mini inconsistently routes
    // "withdraw/deposit ... my perp(s) account" (sometimes to the yield path, sometimes
    // asking "proceed?" then failing). If no card was built and the message is clearly a
    // perps funds move, build the card here from real balances so it works regardless of
    // phrasing (including "withdraw all"). Only fires when the model didn't already act.
    if (!action) {
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
      const txt = (lastUser?.text || '').toString()
      const perpsCtx = /\bperp(s|etual|etuals)?\b/i.test(txt) && !/\b(syrup|usde|spusdg|morpho|yield|lend|earn|vault)\b/i.test(txt)
      const isWithdraw = /\b(withdraw|withdrawal|take\s*out|cash\s*out|pull\s*out)\b/i.test(txt)
      const isDeposit = !isWithdraw && /\b(deposit|add\s*(?:funds|margin|money)?|top\s*up|fund)\b/i.test(txt)
      if (perpsCtx && (isWithdraw || isDeposit) && walletAddress && isAddress(walletAddress)) {
        try {
          const geo = await resolvePerpsGeo(request)
          const eligible = geo.source !== 'unknown' && geo.allowed
          if (eligible && PERPS_ENABLED) {
            const amtMatch = txt.match(/\$?\s*(\d+(?:\.\d+)?)/)
            const wantsAll = /\b(all|everything|max|maximum|entire|full)\b/i.test(txt)
            const fundsAction: 'deposit' | 'withdraw' = isWithdraw ? 'withdraw' : 'deposit'
            let amt: number | null = amtMatch ? parseFloat(amtMatch[1]) : null
            let proceed = true

            if (fundsAction === 'withdraw') {
              const acct = await lookupLighterAccount(walletAddress)
              if (!acct) {
                responseText = "You don't have a perps account yet, so there's nothing to withdraw."
                proceed = false
              } else {
                const bal = await getLighterAccountBalance(acct.accountIndex)
                if (wantsAll && bal) amt = bal.availableUsd
                if (bal && amt != null && amt > bal.availableUsd + 1e-6) amt = bal.availableUsd
                if (!bal || amt == null || !(amt > 0)) {
                  responseText =
                    bal && bal.availableUsd <= 0
                      ? 'Your perps account has no free margin to withdraw right now (any margin is backing an open position — close it first).'
                      : 'How much USDG would you like to withdraw from your perps account?'
                  proceed = false
                }
              }
            } else if (amt == null || !(amt > 0)) {
              responseText = 'How much USDG would you like to add to your perps account?'
              proceed = false
            }

            if (proceed && amt != null && amt > 0) {
              const isDep = fundsAction === 'deposit'
              const amtStr = `$${amt.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
              action = {
                id: `act-${Date.now()}`,
                agent: 'perps',
                action: isDep ? `Deposit ${amtStr} into perps account` : `Withdraw ${amtStr} to your wallet`,
                detail: isDep
                  ? `Moves ${amtStr} USDG from your wallet into your perps account as margin.`
                  : `Returns ${amtStr} of free margin from your perps account to your wallet (settles in a few minutes).`,
                metrics: [
                  { label: 'Amount', value: amtStr, positive: true },
                  { label: 'From', value: isDep ? 'Your wallet' : 'Perps account' },
                  { label: 'To', value: isDep ? 'Perps account' : 'Your wallet' },
                ],
                status: 'pending',
                outcome: {
                  title: isDep ? `Deposited ${amtStr} to perps` : `Withdrawing ${amtStr} to wallet`,
                  value: amtStr,
                  meta: isDep ? 'margin added' : 'settling to wallet',
                  activityTitle: isDep ? 'Perps deposit' : 'Perps withdrawal',
                },
                routeVia: 'perps',
                perps: { fundsAction, amountUsdg: amt },
              } as any
              responseText = `Here's the ${isDep ? 'deposit' : 'withdrawal'} preview. Press Confirm on the card to ${isDep ? 'add the margin' : 'send it to your wallet'}, or Review first.`
            }
          }
        } catch (e) {
          console.error('[robin] perps-funds backstop failed:', e)
        }
      }
    }

    // Deterministic perps-OPEN backstop — the model sometimes gathers info (get_perps_info +
    // get_wallet_holdings) but never calls propose_action to build the open card, leaving the
    // user with nothing. If the message clearly says to open a long/short with a margin and
    // leverage, build the preview here from live market data.
    if (!action) {
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
      const txt = (lastUser?.text || '').toString()
      const sideMatch = txt.match(/\b(long|short)\b/i)
      const openIntent =
        /\b(open|go|enter|start|place|take)\b/i.test(txt) &&
        !!sideMatch &&
        !/\b(close|reduce|withdraw|deposit)\b/i.test(txt)
      if (openIntent && walletAddress && isAddress(walletAddress)) {
        try {
          const geo = await resolvePerpsGeo(request)
          if (geo.source !== 'unknown' && geo.allowed && PERPS_ENABLED) {
            const { markets } = await getPerpsMarkets()
            const upper = txt.toUpperCase()
            const market = markets.find((m) => new RegExp(`\\b${m.asset}\\b`).test(upper))
            const levMatch = txt.match(/(\d+(?:\.\d+)?)\s*x\b/i)
            const marginMatch = txt.match(/\$\s*(\d+(?:\.\d+)?)/) || txt.match(/(\d+(?:\.\d+)?)\s*(?:usdg|usd|dollars)/i)
            const side: 'long' | 'short' = sideMatch![1].toLowerCase() === 'short' ? 'short' : 'long'
            const leverage = levMatch ? parseFloat(levMatch[1]) : null
            const marginUsd = marginMatch ? parseFloat(marginMatch[1]) : null
            if (market && leverage && leverage >= 1 && marginUsd && marginUsd > 0) {
              const mkStr = `$${market.markPrice.toLocaleString('en-US', { maximumFractionDigits: market.markPrice < 1 ? 6 : 2 })}`
              const amtStr = `$${marginUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
              action = {
                id: `act-${Date.now()}`,
                agent: 'perps',
                action: `${side === 'short' ? 'Short' : 'Long'} ${market.asset} ${leverage}x with ${amtStr} USDG`,
                detail: `Open a ${leverage}x leveraged ${side} position on ${market.asset} at market price.`,
                metrics: [
                  { label: `${market.asset} Mark Price`, value: mkStr },
                  { label: 'Leverage', value: `${leverage}x` },
                  { label: 'Margin', value: `${amtStr} USDG`, positive: true },
                ],
                status: 'pending',
                outcome: {
                  title: `${side === 'short' ? 'Short' : 'Long'} ${market.asset} ${leverage}x`,
                  value: `${amtStr} margin`,
                  meta: `${leverage}x · ${market.asset}`,
                  activityTitle: `Perps ${side}`,
                },
                routeVia: 'perps',
                perps: { symbol: market.asset, side, marginUsd, leverage, markPrice: market.markPrice, maxSlippageBps: 50 },
              } as any
              responseText = `Here's your ${side} ${market.asset} preview at ${leverage}x with ${amtStr} margin. Press Confirm to place it, or Review first.`
            }
          }
        } catch (e) {
          console.error('[robin] perps-open backstop failed:', e)
        }
      }
    }

    // Deterministic perps PARTIAL-CLOSE backstop — "close half my SUI", "take $10 off my BTC
    // short", "reduce my position by 25%". If no card was built and it's a partial-reduce
    // intent, compute the fraction from the real position and build a reduceOnly card.
    if (!action) {
      const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
      const txt = (lastUser?.text || '').toString()
      const reduceIntent = /\b(close|reduce|trim|cut|lower|decrease|take)\b/i.test(txt)
      const pctMatch = txt.match(/(\d+(?:\.\d+)?)\s*%/)
      const halfWord = /\bhalf\b/i.test(txt)
      const quarterWord = /\bquarter\b/i.test(txt)
      const dollarMatch = txt.match(/\$\s*(\d+(?:\.\d+)?)/)
      const hasPartial = !!(pctMatch || halfWord || quarterWord || dollarMatch)
      const isFundsWord = /\b(withdraw|deposit|add funds|top up)\b/i.test(txt)
      if (reduceIntent && hasPartial && !isFundsWord && walletAddress && isAddress(walletAddress)) {
        try {
          const geo = await resolvePerpsGeo(request)
          if (geo.source !== 'unknown' && geo.allowed && PERPS_ENABLED) {
            const lighter = await getLighterPortfolio(walletAddress)
            if (lighter.hasAccount && lighter.positions.length > 0) {
              const upper = txt.toUpperCase()
              let pos = lighter.positions.find((p) => new RegExp(`\\b${p.symbol}\\b`).test(upper))
              if (!pos && lighter.positions.length === 1) pos = lighter.positions[0]
              if (pos) {
                let reducePct = 1
                if (pctMatch) reducePct = parseFloat(pctMatch[1]) / 100
                else if (halfWord) reducePct = 0.5
                else if (quarterWord) reducePct = 0.25
                else if (dollarMatch && pos.notionalUsd > 0) reducePct = parseFloat(dollarMatch[1]) / pos.notionalUsd
                reducePct = Math.min(1, Math.max(0.0001, reducePct))
                const markPrice = pos.size > 0 ? pos.notionalUsd / pos.size : 0
                const pctLabel = reducePct >= 0.999 ? 'all' : `${Math.round(reducePct * 100)}%`
                const closedNotional = pos.notionalUsd * reducePct
                const notionalStr = `$${closedNotional.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                action = {
                  id: `act-${Date.now()}`,
                  agent: 'perps',
                  action: `Close ${pctLabel} of ${pos.symbol} ${pos.side}`,
                  detail: `Closes ${pctLabel} of your ${pos.symbol} ${pos.side} position (~${notionalStr} notional) at market price.`,
                  metrics: [
                    { label: 'Closing', value: pctLabel },
                    { label: 'Position', value: `${pos.symbol} ${pos.side}` },
                    { label: 'Notional', value: notionalStr },
                  ],
                  status: 'pending',
                  outcome: { title: `Close ${pctLabel} of ${pos.symbol}`, value: notionalStr, meta: `${pos.symbol} ${pos.side}`, activityTitle: 'Perps reduce' },
                  routeVia: 'perps',
                  perps: { symbol: pos.symbol, side: pos.side, markPrice, reduceOnly: true, reducePct, maxSlippageBps: 50 },
                } as any
                responseText = `Here's the preview to close ${pctLabel} of your ${pos.symbol} ${pos.side}. Press Confirm to reduce it, or Review first.`
              }
            } else {
              responseText = 'You have no open perps positions to reduce.'
            }
          }
        } catch (e) {
          console.error('[robin] perps partial-close backstop failed:', e)
        }
      }
    }

    // Hard backstop, not a prompt instruction — Seen twice in prod: the prompt
    // rule alone doesn't hold: the model claimed "the withdrawal has been executed
    // successfully" for an execution that never happened on-chain (once after the user
    // typed "Loose" as text, again after "yes proceed"), and separately claimed an
    // action was "ready for review" without ever calling propose_action (so no card
    // existed to execute). This server never executes anything — the ONLY execution
    // path is the client's Confirm button, and the client posts its own "Done! ... TX"
    // message afterward. Therefore any model text claiming an execution outcome is
    // false by construction at the moment it's generated, and can be replaced
    // unconditionally.
    const claimsExecution =
      /has been (executed|withdrawn|completed|processed)|executed successfully|withdrawn successfully|(withdrawal|swap|deposit|transaction) (was|is now) (successful|complete)|funds have been (withdrawn|moved|transferred)/i.test(
        responseText,
      )
    // "Press Confirm on the card" is legitimate when the MOST RECENT card is still
    // pending (the user can act on it). Previously this scanned the whole history for any
    // pending card — so once a long chat contained one stale pending card, the guard was
    // suppressed forever, letting the model claim "press Confirm" for brand-new actions it
    // never actually built. Only the latest card can be what "press Confirm" refers to.
    const lastRobinCard = Array.isArray(messages)
      ? [...(messages as any[])].reverse().find((m) => m?.role === 'robin' && m?.action)?.action
      : undefined
    const priorPendingCard = lastRobinCard?.status === 'pending'
    const claimsCardExists =
      !action &&
      !priorPendingCard &&
      (
        /(action|withdrawal|swap|deposit|lending|trade).{0,60}ready (for|to)/i.test(responseText) ||
        /\b(press|click|tap|hit)\b.{0,50}\b(confirm|review|draw|loose)\b/i.test(responseText) ||
        /\baction card\b/i.test(responseText)
      )

    if (claimsExecution) {
      responseText =
        "Nothing has been executed — I can only preview actions, never run them. If there's an action card above, press its Confirm button (or type \"confirm\") to execute it. To see what actually happened, ask me for your holdings or yield positions and I'll check the chain."
    } else if (claimsCardExists) {
      responseText =
        "I wasn't able to prepare that action correctly — no preview card was actually created, so there's nothing to confirm yet. Ask me again (for example: \"withdraw 5 USDG from the syrupUSDG market\") and I'll build a fresh preview."
    }

    // No card produced (a clarification, an info answer, or a guard fired) → offer
    // tappable next-step commands the user can act on immediately, tailored to what they
    // just asked about. When a card WAS built, the card is the next step, so no chips.
    const lastUserText = (Array.isArray(messages) ? [...messages] : [])
      .reverse()
      .find((m: any) => m?.role === 'user')?.text ?? ''
    const suggestions = !action && !bridgeInfo ? buildSuggestions(lastUserText) : undefined

    return NextResponse.json({ text: responseText || fallback, action, bridgeInfo, ...(suggestions ? { suggestions } : {}) })
  } catch (err) {
    console.error('[robin] API error:', err)
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    console.error('[robin] Error details:', errorMessage)
    
    return NextResponse.json(
      { 
        text: process.env.NODE_ENV === 'development' 
          ? `Error: ${errorMessage}` 
          : 'Something went wrong on my end. Please try again in a moment.' 
      },
      { status: 500 },
    )
  }
}
