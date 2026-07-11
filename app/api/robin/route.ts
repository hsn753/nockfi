import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { isAddress } from 'viem'
import { fetchWalletBalances } from '@/lib/get-balances'
import { fetchSwapQuote, SWAP_TOKENS } from '@/lib/get-swap-quote'
import { getReferencePrices } from '@/lib/get-prices'
import { getTrendingTokens, findTokensBySymbol } from '@/lib/get-trending-tokens'
import type { ActionPreview, AgentId, ChatMessage } from '@/components/nock/data'

export const dynamic = 'force-dynamic'

let openaiClient: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return openaiClient
}

const SUPPORTED_TOKENS_LIST = Object.keys(SWAP_TOKENS).join(', ')

function buildSystemPrompt(walletAddress?: string): string {
  const walletLine = walletAddress
    ? `The user's connected wallet address on Robinhood Chain is ${walletAddress}.`
    : `The user does not have a wallet connected right now.`

  return `You are Robin, the concierge for Nock, an onchain agent platform. You help users put their capital to work across five specialized agents: yield, swap, perps, stock tokens, and vaults.

CRITICAL: You ONLY help with DeFi, crypto, and on-chain actions. If someone asks about anything else (politics, general knowledge, unrelated topics), politely redirect them back to what you can help with.

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
- Each holding includes a real usdValue (ETH from CoinGecko, stock tokens from live market price). usdValue is a number — including 0 for a zero balance, which just means $0, not "unavailable." It is only null if a price feed failed for that specific asset; only then say its dollar value isn't available right now. Present both the token amount and its $ value, and total everything with a usdValue into a portfolio $ figure.
- These balances are specifically on Robinhood Chain, not the user's other wallets or chains (Ethereum mainnet, etc). If everything comes back at 0, say so plainly and mention they likely need to bridge funds onto Robinhood Chain first (canonical Arbitrum bridge or a supported cross-chain route) before they show up here — don't imply something is broken.

When the user wants to swap, trade, buy, or sell any token:
- If it's one of the verified tokens (${SUPPORTED_TOKENS_LIST}), call get_swap_quote directly with the symbol. Everything except USDG trades against USDG (e.g. ETH -> USDG, USDG -> TSLA, or TSLA -> USDG). If the user says USDC or dollars, treat that as USDG — there is no separate USDC on Robinhood Chain here. If the user doesn't specify an amount, ask for one before calling the tool.
- If the user names a memecoin or community token NOT in that verified list, call get_trending_tokens with that symbol first to look it up. This list is completely unverified — Robinhood Chain is permissionless, anyone can deploy a token with any name, and real impersonator tokens already exist (multiple different contracts all called "ROBINHOOD" or "HOOD" at different addresses, none of them official). Never silently pick one:
  - If get_trending_tokens finds exactly one match, tell the user this is an unverified community token (not vetted by Robinhood, real scam/rug risk), state its exact contract address, and ask them to confirm it's the one they mean before quoting.
  - If it finds multiple matches for the same symbol, explicitly list all of them with their addresses and volume/liquidity, warn that duplicate-name tokens are a common scam pattern, and ask the user which specific address they mean. Do not default to the highest-volume one without asking — high volume does not mean legitimate.
  - If it finds none, say so and ask if they have the exact contract address.
  - Once the user confirms a specific address, call get_swap_quote using that contract address as fromToken/toToken (not the symbol).
- This exact verified-token list is authoritative right now, even if earlier messages in this same conversation (from you or the user) mentioned a different or shorter list. It can grow over time — always answer "what's supported" questions from the list above, never from something said earlier in the conversation.
- When you answer a general "what tokens are supported" or "what can I swap" question, always mention BOTH things: the verified list above, AND that you can also look up any specific memecoin or community token by name (unverified, real scam risk, but real trading happens on Robinhood Chain). Don't imply the verified list is the only thing swappable — that's not true and undersells what this app can actually do.
- If the quote comes back with an error field, tell the user what it actually says. Do not guess prices, and never say a token is "not supported" just because one quote attempt failed — check the real error first. If the error mentions the buy token is not authorized for trade, that specific token IS supported by this app, but this specific wallet isn't authorized to trade regulated stock tokens (a compliance restriction on the wallet, not a temporary bug or a missing feature) — explain it that way, don't call the token unsupported.
- If the quote succeeds, call propose_action using the real fromAmount, toAmount, and exchangeRate from the quote. Never substitute invented numbers. If the quote's verified field is false, the outcome/detail text in propose_action MUST include an explicit unverified-token warning — this is not optional.

When the user asks to do something else with their money or assets:
1. Call the relevant tool to get current data. Choose from get_yield_options, get_perps_info, get_stock_token_info, or check_vault_limits.
2. Based on the data returned, call propose_action with a fully structured preview of the action you recommend.
3. After propose_action returns, write one or two sentences in plain language explaining what you found and what you are proposing. Invite the user to use the Draw button to review it.

If the user asks about anything NOT related to crypto, DeFi, trading, or blockchain:
- Say: "I'm here to help with your crypto and DeFi needs. I can help you swap tokens, check your holdings, find yield opportunities, or manage positions. What would you like to do?"
- Do not answer general knowledge questions, current events, or anything outside of crypto/DeFi.

Rules:
- Keep all copy human, in sentence case.
- Never use em dashes.
- Never use markdown — no **bold**, no bullet dashes, no headers. The chat renders your text as plain text, so markdown syntax shows up as literal asterisks and dashes. Write plain sentences, and use "X: Y, Z: W" style lists inline if you need to enumerate a few things.
- Never invent balances, prices, or protocol names. Only use data from tool calls.
- Never say you will execute or confirm anything. You only preview. The user clicks Draw to review and Loose to execute.
- Be warm and direct. Get to the point fast.
- Stay strictly on topic: crypto, DeFi, and on-chain actions only.`
}

function callStubTool(name: string, _input: unknown): unknown {
  switch (name) {
    case 'get_yield_options':
      return {
        options: [
          { protocol: 'Marlin', asset: 'USDC', apy: 7.02, tvl: '$42M', risk: 'Low', lockup: 'None' },
          { protocol: 'Fluid', asset: 'USDC', apy: 5.8, tvl: '$88M', risk: 'Low', lockup: 'None' },
          { protocol: 'Morpho', asset: 'USDC', apy: 6.4, tvl: '$61M', risk: 'Low', lockup: 'None' },
        ],
      }
    case 'get_perps_info':
      return {
        markets: [
          { asset: 'ETH', markPrice: '$3,327.10', fundingRate: '0.01%/8h', openInterest: '$142M', maxLeverage: '10x' },
          { asset: 'BTC', markPrice: '$107,440.00', fundingRate: '0.008%/8h', openInterest: '$280M', maxLeverage: '10x' },
        ],
        userCollateral: '$0', note: 'Deposit collateral to open a position.',
      }
    case 'get_stock_token_info':
      return {
        tokens: [
          { symbol: 'TSLA', referencePrice: '$347.80', change24h: '+1.2%' },
          { symbol: 'AMD',  referencePrice: '$168.40', change24h: '-0.4%' },
          { symbol: 'AMZN', referencePrice: '$224.10', change24h: '+0.8%' },
          { symbol: 'AAPL', referencePrice: '$254.10', change24h: '+0.6%' },
          { symbol: 'PLTR', referencePrice: '$41.20', change24h: '+3.3%' },
        ],
        tradingHours: '24/7', requiresNock: true,
      }
    case 'check_vault_limits':
      return {
        vaults: [
          { name: 'Balanced', targetApy: '5.10%', risk: 'Balanced', tvl: '$8.2M', minDeposit: '$100' },
          { name: 'Aggressive', targetApy: '12.40%', risk: 'High', tvl: '$2.1M', minDeposit: '$500' },
          { name: 'Conservative', targetApy: '3.20%', risk: 'Low', tvl: '$14.8M', minDeposit: '$50' },
        ],
        requiresNock: true,
      }
    default:
      return { error: `Unknown tool: ${name}` }
  }
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
      name: 'get_swap_quote',
      description: `Fetches a real live swap quote from the 0x API for trading on Robinhood Chain. fromToken/toToken can be a verified symbol (${SUPPORTED_TOKENS_LIST}) or, for a memecoin confirmed via get_trending_tokens, its exact contract address. Everything except USDG trades against USDG. Call this whenever the user wants to swap, trade, buy, or sell any of these tokens. amount is the human-readable sell amount (e.g. "100" for 100 USDG). Never invent prices — always call this tool.`,
      parameters: {
        type: 'object',
        properties: {
          fromToken: { type: 'string', description: 'Token symbol to sell, e.g. USDG or TSLA' },
          toToken:   { type: 'string', description: 'Token symbol to buy, e.g. TSLA or USDG' },
          amount:    { type: 'string', description: 'Human-readable amount to sell, e.g. "100" or "0.5"' },
        },
        required: ['fromToken', 'toToken', 'amount'],
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
            description: 'Short label for the action, e.g. "Swap 100 USDG for TSLA"',
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
              title: { type: 'string', description: 'Short position title, e.g. "TSLA position"' },
              value: { type: 'string', description: 'Dollar value of the position, e.g. "$347.80"' },
              meta: { type: 'string', description: 'Position meta label, e.g. "1.0 TSLA"' },
              activityTitle: { type: 'string', description: 'Activity log title, e.g. "Swapped 100 USDG for TSLA"' },
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

    console.log('[robin] Wallet address received:', walletAddress)

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
    let bridgeInfo: { link: string; sourceChain: string; destinationChain: string; etaMinutes: number } | undefined

    // Loop so the model can chain tool calls within one request — e.g. get_swap_quote
    // to fetch real numbers, then propose_action to build the preview card from them.
    // A single non-looped round (the previous implementation) meant propose_action was
    // never reachable after a data-fetching tool call, so no Draw/Loose card ever appeared.
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

        let result: unknown

        if (functionName === 'propose_action') {
          const input = functionArgs as ProposeActionInput

          // A swap preview is only real if it's backed by a transaction from a quote
          // fetched in THIS turn — otherwise the model can (and did, in testing) build a
          // preview card from numbers it just remembered/recomputed from earlier chat
          // history, which looks identical but has no transaction to actually execute.
          if (input.agent === 'swap' && !lastSwapQuote?.transaction) {
            result = {
              error: 'No fresh quote available. Call get_swap_quote with the current fromToken/toToken/amount first, then call propose_action again with its real numbers. Do not reuse or recompute numbers from earlier in the conversation.',
            }
          } else {
            action = {
              id: `act-${Date.now()}`,
              agent: input.agent,
              action: input.action,
              detail: input.detail,
              metrics: input.metrics,
              status: 'pending',
              outcome: input.outcome,
              ...(input.agent === 'swap' && lastSwapQuote?.transaction ? {
                transactionData: lastSwapQuote.transaction,
                fromToken: lastSwapQuote.fromSymbol,
                toToken: lastSwapQuote.toSymbol,
                amount: lastSwapQuote.fromAmount,
                verified: lastSwapQuote.verified !== false,
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

        } else if (functionName === 'get_swap_quote') {
          const { fromToken, toToken, amount } = functionArgs
          if (!fromToken || !toToken || !amount) {
            result = { error: 'fromToken, toToken, and amount are all required.' }
          } else {
            const supportedSymbols = Object.keys(SWAP_TOKENS).join(', ')
            try {
              const quote = await fetchSwapQuote({
                fromToken,
                toToken,
                amount,
                taker: walletAddress,
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

        } else if (functionName === 'get_stock_token_info') {
          try {
            const prices = await getReferencePrices()
            result = {
              tokens: Object.keys(SWAP_TOKENS)
                .filter((s) => s !== 'ETH' && s !== 'USDG')
                .map((symbol) => ({
                  symbol,
                  referencePrice: prices[symbol] !== undefined ? `$${prices[symbol].toFixed(2)}` : null,
                })),
              tradingHours: '24/7',
              requiresNock: true,
            }
          } catch {
            result = callStubTool(functionName, functionArgs)
          }

        } else {
          result = callStubTool(functionName, functionArgs)
        }

        openaiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        })
      }
    }

    const fallback =
      "I'm not sure how to help with that. Try asking me what you hold, to put idle funds to work, swap tokens, open a perps position, buy a stock token, or deposit into a vault."

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
