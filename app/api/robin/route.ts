import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { isAddress } from 'viem'
import { fetchWalletBalances, fetchArbitraryTokenBalance } from '@/lib/get-balances'
import { fetchSwapQuote, SWAP_TOKENS } from '@/lib/get-swap-quote'
import { getReferencePrices } from '@/lib/get-prices'
import { getTrendingTokens, findTokensBySymbol, getTokenPriceByAddress } from '@/lib/get-trending-tokens'
import { requireAuthenticatedWallet, AuthError } from '@/lib/auth-server'
import { getYieldOptions, buildYieldDeposit } from '@/lib/get-yield-data'
import { getMorphoMarketData, getUserMarketPositions, buildMarketSupply, buildMarketWithdraw, MORPHO_MARKETS, type MorphoMarketKey } from '@/lib/get-morpho-markets'
import { getPerpsMarkets } from '@/lib/get-perps-data'
import { getStockTokens, findStockToken } from '@/lib/get-stock-tokens'
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

function buildSystemPrompt(walletAddress?: string): string {
  const walletLine = walletAddress
    ? `The user's connected wallet address on Robinhood Chain is ${walletAddress}.`
    : `The user does not have a wallet connected right now.`

  return `You are Robin, the concierge for Nock, an onchain agent platform. You help users put their capital to work across five specialized agents: yield, swap, perps, stock tokens, and vault (guardrails).

CRITICAL: You ONLY help with DeFi, crypto, and on-chain actions. If someone asks about anything else (politics, general knowledge, unrelated topics), politely redirect them back to what you can help with.

IMPORTANT: There is also a real, unrelated memecoin traded on Robinhood Chain called NOCK (ticker NOCK) — same word as this app's name, but a completely different thing: a community token with its own contract address, price, and liquidity, unrelated to and not issued by this app. When the user asks about "NOCK" holdings, balance, or swapping — e.g. "how much NOCK do I have," "swap NOCK for ETH" — they mean that token. Treat it exactly like any other unverified memecoin (look it up via get_trending_tokens/get_token_balance, confirm the exact address, warn it's unverified) — never treat a NOCK question as confused, off-topic, or about this app itself.

${walletLine}

When the user asks for their wallet address or deposit address:
- Answer directly with the address above. Do not call a tool for this, you already have it.
- If no wallet is connected, tell them to connect one first.

When the user asks how to bridge, move, or send funds onto Robinhood Chain from Ethereum or another chain:
- IMMEDIATELY call get_bridge_info. This is REQUIRED — never answer a bridging question from memory, always call the tool first.
- The app shows the link, chain, and ETA in a card with its own button right below your reply — do not repeat those details or include the URL yourself. Just say one short sentence confirming it's ready to bridge into their connected wallet, and mention you'll let them know once it lands.
- If no wallet is connected, tell them to connect one first so you can give them the right deposit address.

When the user asks what they hold, their portfolio, their balances, or anything about their specific holdings:
- IMMEDIATELY call get_wallet_holdings tool. This is REQUIRED - you MUST call this tool, never skip it.
- Do not ask if they have a wallet connected - just call the tool, it will tell you if no wallet is connected.
- Each holding includes a real usdValue (ETH and WETH from CoinGecko, USDG hardcoded at 1). usdValue is a number — including 0 for a zero balance, which just means $0, not "unavailable." It is only null if a price feed failed for that specific asset; only then say its dollar value isn't available right now. Present both the token amount and its $ value, and total everything with a usdValue into a portfolio $ figure.
- These balances are specifically on Robinhood Chain, not the user's other wallets or chains (Ethereum mainnet, etc). If everything comes back at 0, say so plainly and mention they likely need to bridge funds onto Robinhood Chain first (canonical Arbitrum bridge or a supported cross-chain route) before they show up here — don't imply something is broken.
- If the user asks about their balance of one specific VERIFIED token (${SUPPORTED_TOKENS_LIST}) — e.g. "what's my USDG balance" — just call get_wallet_holdings and answer from that one entry. Do NOT call get_token_balance for a verified token; that tool takes a raw contract address, not a symbol, and will fail or be misused if you pass a symbol like "USDG" as if it were an address.
- get_wallet_holdings ONLY checks the verified token list (${SUPPORTED_TOKENS_LIST}). It cannot see memecoins or any other token, even one the user swapped into through this app. If the user asks specifically about a memecoin/community token they hold that's NOT in that verified list (by name or address), you MUST call get_token_balance with that token's exact contract address (look it up via get_trending_tokens first if you only have a symbol) — this is a real, separate on-chain balance check. NEVER say a user holds "0" of a specific token, or that a token isn't in their wallet, without having actually called the right tool for it. Saying a specific number with no tool call behind it is exactly the kind of invented data you must never produce.

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
- To buy or sell: resolve the OFFICIAL contract address via get_stock_tokens (pass the symbol), then call get_swap_quote using that exact address as toToken (buying with USDG) or fromToken (selling), then propose_action with agent "stock" and the real quote numbers. Same rules as swaps: never guess amounts, always quote fresh.
- If a symbol isn't in the registry, say Robinhood doesn't issue that stock token — do not go looking for it among unverified tokens.

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

When the user asks to actually open a perps position: call get_perps_info to show them the real current market data (mark price, funding, open interest, max leverage), then tell them plainly that opening a position isn't executable through Nock yet — this is real, live market data from Lighter for informational purposes only right now. Never call propose_action for the perps agent under any circumstances yet, even if they explicitly ask to open a position — there is no real order-placement flow behind it yet.

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
}

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_wallet_holdings',
      description: `Returns the user's real on-chain balances from their connected wallet, each with a live usdValue, across all supported tokens: ${SUPPORTED_TOKENS_LIST}. Call this whenever the user asks what they hold, their portfolio, their balances, or anything about their specific holdings. Never answer holdings questions from memory.`,
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
      name: 'get_perps_info',
      description: 'Returns real, live perpetual futures market data from Lighter (a separate exchange that accepts Robinhood Chain assets as margin) — real mark price, funding rate, open interest, and max leverage (derived from Lighter\'s own live margin requirement). Scoped to crypto/memecoin markets only. Opening a position through this app is not built yet — say so plainly if the user asks to actually open one. Pass a symbol to look up one specific market, or omit it for the current top markets by volume. Call this whenever the user asks what perps markets exist, without necessarily proposing an action.',
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
      description: `Fetches a real live swap quote from the 0x API for trading on Robinhood Chain. fromToken/toToken can be a verified symbol (${SUPPORTED_TOKENS_LIST}) or, for a memecoin confirmed via get_trending_tokens or a stock token from get_stock_tokens, its exact contract address. Everything except USDG trades against USDG. Call this whenever the user wants to swap, trade, buy, or sell any of these tokens. Pass EITHER amount (token units to sell, e.g. "0.5" ETH) OR amountUsd (dollar value to sell, e.g. "2" for $2 worth — the server converts at the live price; NEVER convert dollars to token units yourself, and NEVER read "$2 of ETH" as 2 ETH). Never invent prices — always call this tool.`,
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
        },
        required: ['agent', 'action', 'detail', 'metrics', 'outcome'],
      },
    },
  },
]

export async function POST(request: Request) {
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

    console.log('[robin] Wallet address received:', walletAddress, 'has identity token:', !!request.headers.get('x-privy-identity-token'))

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
      ...messages.map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.text,
      })),
    ]

    let action: ActionPreview | undefined
    let responseText = ''
    let lastSwapQuote: any = null
    let lastYieldQuote:
      | Awaited<ReturnType<typeof buildYieldDeposit>>
      | Awaited<ReturnType<typeof buildMarketSupply>>
      | Awaited<ReturnType<typeof buildMarketWithdraw>>
      | null = null
    let bridgeInfo: { link: string; sourceChain: string; destinationChain: string; etaMinutes: number } | undefined

    // Loop so the model can chain tool calls within one request — e.g. get_swap_quote
    // to fetch real numbers, then propose_action to build the preview card from them.
    // A single non-looped round (the previous implementation) meant propose_action was
    // never reachable after a data-fetching tool call, so no action card ever appeared.
    for (let round = 0; round < 6; round++) {
      const response = await getOpenAI().chat.completions.create({
        model: 'gpt-4o-mini',
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

          // Hard backstop, not just a prompt instruction — get_perps_info now returns
          // real market data (mark price, funding, OI), but there is no real order-
          // placement flow wired up yet (Lighter uses off-chain order matching with its
          // own sub-account/API-key signing scheme, not a plain on-chain tx). Without
          // this, the model could build a preview card from real numbers that
          // handleLoose's still-fully-mocked fallback would then fake-execute with a
          // checkmark — real data plus a fake execution path is worse than the old fake
          // stub data it replaced.
          if (input.agent === 'perps') {
            result = {
              error: 'Perps positions are not executable through Nock yet — do not propose an action for this. Present the real market data from get_perps_info directly and tell the user opening a position is informational-only for now.',
            }
            openaiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })
            continue
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
          let mismatchedTokenWord: string | undefined
          let stockImpersonatorWord: string | undefined
          if ((input.agent === 'swap' || input.agent === 'stock') && lastSwapQuote?.transaction && lastUserMessage) {
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
            const candidates = extractCandidateTokenWords(lastUserMessage.text)

            // Stock symbols resolve through the verified registry only. If the user
            // named a symbol Robinhood officially issues, the quote must involve that
            // exact contract — a same-ticker impersonator (four fake TSLAs exist) must
            // never be tradeable through a stock request. When the official address IS
            // on the quote, the symbol counts as matched for the mismatch guard below
            // (the quote sides show raw addresses for non-SWAP_TOKENS assets, so the
            // symbol never literally appears there).
            const matchedViaRegistry = new Set<string>()
            for (const w of candidates) {
              const official = await findStockToken(w).catch(() => null)
              if (!official) continue
              if (quoteAddresses.has(official.address.toLowerCase())) {
                matchedViaRegistry.add(w)
              } else {
                stockImpersonatorWord = w
              }
            }

            mismatchedTokenWord = candidates.find((w) => !quoteSymbols.has(w) && !matchedViaRegistry.has(w))
            if (stockImpersonatorWord) mismatchedTokenWord = undefined
          }

          if ((input.agent === 'swap' || input.agent === 'stock') && !lastSwapQuote?.transaction) {
            result = {
              error: 'No fresh quote available. Call get_swap_quote with the current fromToken/toToken/amount first, then call propose_action again with its real numbers. Do not reuse or recompute numbers from earlier in the conversation.',
            }
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
            if ((input.agent === 'swap' || input.agent === 'stock') && lastSwapQuote?.transaction) {
              const prices = await getReferencePrices()
              let fromPrice = prices[(lastSwapQuote.fromSymbol || '').toUpperCase()]
              // Selling a stock token: the sell side is a raw address with no reference
              // price — use the registry's live pool price instead of giving up.
              if (fromPrice === undefined && typeof lastSwapQuote.sellTokenAddress === 'string') {
                const stocks = await getStockTokens().catch(() => [])
                const match = stocks.find((s) => s.address.toLowerCase() === lastSwapQuote.sellTokenAddress.toLowerCase())
                if (match?.priceUsd != null) fromPrice = match.priceUsd
              }
              const fromAmountNum = parseFloat(String(lastSwapQuote.fromAmount).replace(/,/g, ''))
              outcomeValue = fromPrice !== undefined && !isNaN(fromAmountNum)
                ? `$${(fromAmountNum * fromPrice).toFixed(2)}`
                : 'Value unavailable'
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
            let guardrailViolation: string | undefined
            if ((input.agent === 'swap' || input.agent === 'stock' || input.agent === 'yield') && !isWithdrawal && walletAddress) {
              const outcomeValueNum = parseFloat(outcomeValue.replace(/[^0-9.]/g, ''))
              if (!isNaN(outcomeValueNum)) {
                const wallet = await getWalletByAddress(walletAddress)
                const guardrails = wallet ? await getGuardrails(wallet.id) : { maxUsdPerTransaction: null }
                if (guardrails.maxUsdPerTransaction !== null && outcomeValueNum > guardrails.maxUsdPerTransaction) {
                  guardrailViolation = `This action is worth about ${outcomeValue}, which is over the user's set spend limit of $${guardrails.maxUsdPerTransaction} per transaction. Do not propose this action. Tell the user plainly it was blocked by their own spend limit, and that they can raise it from Settings if they want to allow it.`
                }
              }
            }

            if (guardrailViolation) {
              result = { error: guardrailViolation }
              openaiMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) })
              continue
            }

            action = {
              id: `act-${Date.now()}`,
              agent: input.agent,
              action: input.action,
              detail: input.detail,
              metrics: input.metrics,
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
            } as any
            result = { status: 'preview_ready' }
          }

        } else if (functionName === 'get_wallet_holdings') {
          if (!walletAddress || !isAddress(walletAddress)) {
            result = { error: 'No wallet connected. Ask the user to connect their wallet first.' }
          } else {
            try {
              console.log('[robin] Fetching balances for:', walletAddress)
              const balances = await fetchWalletBalances(walletAddress)
              console.log('[robin] Balances fetched:', balances)
              result = {
                balances,
                note: 'Live on-chain balances with live USD reference prices.',
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
            const tokens = symbol ? await findTokensBySymbol(symbol) : await getTrendingTokens()
            result = {
              tokens,
              warning: 'These are unverified community/memecoin tokens on Robinhood Chain, not vetted by Robinhood. Anyone can deploy a token with any name — real impersonator tokens exist. Confirm the exact contract address with the user before quoting.',
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
          const { fromToken, toToken, amount: amountArg, amountUsd } = functionArgs as {
            fromToken?: string; toToken?: string; amount?: string; amountUsd?: string
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
          const hasUserSpecifiedAmount = messages.some(
            (m) => m.role === 'user' && /\d/.test(m.text.replace(/0x[a-fA-F0-9]{40}/g, '')),
          )

          if (!hasUserSpecifiedAmount) {
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
              const quote = await fetchSwapQuote({
                fromToken,
                toToken,
                amount,
                taker: swapTaker,
              })
              if (!quote.error) {
                lastSwapQuote = quote
              }
              result = quote.error
                ? { error: quote.error, supportedTokens: supportedSymbols }
                : { ...quote, supportedTokens: supportedSymbols }
            } catch {
              result = { error: 'Failed to reach the 0x swap API. Try again in a moment.', supportedTokens: supportedSymbols }
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
                    note: 'Official Robinhood stock token, verified on-chain against the official issuer. priceUsd is the live on-chain trading price (24/7 — it can drift from the official market close). Price exposure only, not share ownership. To trade it, quote with get_swap_quote using this exact address.',
                  }
                : { error: `Robinhood doesn't issue an official stock token with the symbol "${symbol}". Do not look for it among unverified tokens — tell the user it isn't available as an official stock token.` }
            } else {
              const tokens = await getStockTokens()
              result = {
                tokens: tokens.slice(0, 25),
                totalCount: tokens.length,
                note: 'Official Robinhood stock tokens only, each verified on-chain against the official issuer, sorted by 24h volume. Prices are live on-chain trading prices (24/7). Price exposure, not share ownership — no dividends or voting rights.',
              }
            }
          } catch (err) {
            console.error('[robin] get_stock_tokens error:', err)
            result = { error: 'Could not load the verified stock token registry. Try again in a moment.' }
          }

        } else if (functionName === 'get_perps_info') {
          const { symbol } = functionArgs as { symbol?: string }
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
              const guardrails = wallet ? await getGuardrails(wallet.id) : { maxUsdPerTransaction: null }
              result = {
                maxUsdPerTransaction: guardrails.maxUsdPerTransaction,
                note: guardrails.maxUsdPerTransaction === null
                  ? 'No spend limit is set — any swap or yield deposit amount can be proposed.'
                  : `Proposed swaps and yield deposits over $${guardrails.maxUsdPerTransaction} will be declined before a preview is ever shown.`,
                automaticProtections: [
                  'Every proposed action is built from a fresh, live quote — never a reused or guessed number.',
                  'A swap or deposit amount is never invented — Robin always asks the user for an exact amount first.',
                  'If the user mentions a token that does not match the current quote, the action is refused rather than silently substituted.',
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
    const claimsCardExists =
      !action &&
      /(action|withdrawal|swap|deposit|lending).{0,60}ready (for|to)/i.test(responseText) &&
      /\b(draw|loose|review|confirm)\b/i.test(responseText)

    if (claimsExecution) {
      responseText =
        "Nothing has been executed — I can only preview actions, never run them. If there's an action card above, press its Confirm button (or type \"confirm\") to execute it. To see what actually happened, ask me for your holdings or yield positions and I'll check the chain."
    } else if (claimsCardExists) {
      responseText =
        "I wasn't able to prepare that action correctly — no preview card was actually created, so there's nothing to confirm yet. Ask me again (for example: \"withdraw 5 USDG from the syrupUSDG market\") and I'll build a fresh preview."
    }

    return NextResponse.json({ text: responseText || fallback, action, bridgeInfo })
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
