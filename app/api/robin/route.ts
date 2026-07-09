import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { isAddress } from 'viem'
import { fetchWalletBalances } from '@/lib/get-balances'
import { fetchSwapQuote, SWAP_TOKENS } from '@/lib/get-swap-quote'
import type { ActionPreview, AgentId, ChatMessage } from '@/components/nock/data'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are Robin, the concierge for Nock, an onchain agent platform. You help users put their capital to work across five specialized agents: yield, swap, perps, stock tokens, and vaults.

When the user asks what they hold, their portfolio, their balances, or anything about their specific holdings:
- Call get_wallet_holdings immediately. Do not guess or invent any balances.
- Present the real amounts you get back. Since live prices are not available yet, give amounts and symbols only and mention that dollar values are coming soon. Do not make up USD values.

When the user wants to swap, trade, buy, or sell any token:
- Call get_swap_quote with fromToken, toToken, and amount. Supported tokens are USDG, TSLA, AMD, AMZN, NFLX, PLTR. Stock tokens trade against USDG (e.g. USDG -> TSLA or TSLA -> USDG). If the user doesn't specify an amount, ask for one before calling the tool.
- If the quote comes back with an error field, tell the user what it says. Do not guess prices.
- If the quote succeeds, call propose_action using the real fromAmount, toAmount, and exchangeRate from the quote. Never substitute invented numbers.

When the user asks to do something else with their money or assets:
1. Call the relevant tool to get current data. Choose from get_yield_options, get_perps_info, get_stock_token_info, or check_vault_limits.
2. Based on the data returned, call propose_action with a fully structured preview of the action you recommend.
3. After propose_action returns, write one or two sentences in plain language explaining what you found and what you are proposing. Invite the user to use the Draw button to review it.

If the user is just chatting, asking a general question, or not requesting an onchain action, answer helpfully without calling any tools.

Rules:
- Keep all copy human, in sentence case.
- Never use em dashes.
- Never invent balances, prices, or protocol names. Only use data from tool calls.
- Never say you will execute or confirm anything. You only preview. The user clicks Draw to review and Loose to execute.
- Be warm and direct. Get to the point fast.`

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
          { symbol: 'NFLX', referencePrice: '$1,124.50', change24h: '+2.1%' },
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

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'get_wallet_holdings',
    description: "Returns the user's real on-chain balances from their connected wallet: native ETH and the five stock tokens (TSLA, AMD, AMZN, NFLX, PLTR). Call this whenever the user asks what they hold, their portfolio, their balances, or anything about their specific holdings. Never answer holdings questions from memory.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_yield_options',
    description: "Returns current lending options and APYs for stablecoin balances across vetted protocols.",
    input_schema: {
      type: 'object',
      properties: { asset: { type: 'string', description: 'Token symbol to get yield options for, e.g. USDC' } },
      required: [],
    },
  },
  {
    name: 'get_swap_quote',
    description: 'Fetches a real live swap quote from the 0x API for trading on Robinhood Chain. Supported tokens: USDG, TSLA, AMD, AMZN, NFLX, PLTR. Stock tokens trade against USDG. Call this whenever the user wants to swap, trade, buy, or sell any of these tokens. amount is the human-readable sell amount (e.g. "100" for 100 USDG). Never invent prices — always call this tool.',
    input_schema: {
      type: 'object',
      properties: {
        fromToken: { type: 'string', description: 'Token symbol to sell, e.g. USDG or TSLA' },
        toToken:   { type: 'string', description: 'Token symbol to buy, e.g. TSLA or USDG' },
        amount:    { type: 'string', description: 'Human-readable amount to sell, e.g. "100" or "0.5"' },
      },
      required: ['fromToken', 'toToken', 'amount'],
    },
  },
  {
    name: 'get_perps_info',
    description: "Returns perpetual futures market data and the user's current collateral and open positions.",
    input_schema: {
      type: 'object',
      properties: { asset: { type: 'string', description: 'Asset to get perps info for, e.g. ETH' } },
      required: [],
    },
  },
  {
    name: 'get_stock_token_info',
    description: 'Returns current reference prices for tokenized stock tokens: TSLA, AMD, AMZN, NFLX, PLTR.',
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Stock symbol, e.g. TSLA' } },
      required: [],
    },
  },
  {
    name: 'check_vault_limits',
    description: "Returns vault deposit limits and current APY targets.",
    input_schema: {
      type: 'object',
      properties: { vaultName: { type: 'string', description: 'Vault name to check, e.g. Balanced' } },
      required: [],
    },
  },
  {
    name: 'propose_action',
    description: 'Emit a structured action preview card for the user to review before executing. Call this after gathering data from the relevant tool.',
    input_schema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: ['yield', 'perps', 'swap', 'stock', 'vault'],
          description: 'Which agent handles this action',
        },
        action: {
          type: 'string',
          description: 'Short label for the action, e.g. "Lend 12,400 USDC on Marlin"',
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
            title: { type: 'string', description: 'Short position title, e.g. "USDC lending"' },
            value: { type: 'string', description: 'Dollar value of the position, e.g. "$12,400.00"' },
            meta: { type: 'string', description: 'Position meta label, e.g. "7.02% APY"' },
            activityTitle: { type: 'string', description: 'Activity log title, e.g. "Lent 12,400 USDC on Marlin"' },
            activityAmount: { type: 'string', description: 'Optional amount shown in the activity row' },
          },
          required: ['title', 'value', 'meta', 'activityTitle'],
        },
      },
      required: ['agent', 'action', 'detail', 'metrics', 'outcome'],
    },
  },
]

export async function POST(request: Request) {
  try {
    // Validate API key
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('[robin] Missing ANTHROPIC_API_KEY')
      return NextResponse.json(
        { text: 'AI service not configured. Please contact support.' },
        { status: 500 },
      )
    }

    const { messages, walletAddress } = (await request.json()) as {
      messages: ChatMessage[]
      walletAddress?: string
    }

    const anthropicMessages: Anthropic.Messages.MessageParam[] = messages.map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    }))

    let action: ActionPreview | undefined
    let responseText = ''
    let lastSwapQuote: any = null

    for (let i = 0; i < 10; i++) {
      const response = await client.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: anthropicMessages,
      })

      const textBlocks = response.content.filter(
        (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
      )

      if (response.stop_reason === 'end_turn') {
        responseText = textBlocks.map((b) => b.text).join(' ').trim()
        break
      }

      if (response.stop_reason === 'tool_use') {
        anthropicMessages.push({ role: 'assistant', content: response.content })

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue

          let result: unknown

          if (block.name === 'propose_action') {
            const input = block.input as ProposeActionInput
            action = {
              id: `act-${Date.now()}`,
              agent: input.agent,
              action: input.action,
              detail: input.detail,
              metrics: input.metrics,
              status: 'pending',
              outcome: input.outcome,
              // Include swap transaction data if this is a swap action
              ...(input.agent === 'swap' && lastSwapQuote?.transaction ? {
                transactionData: lastSwapQuote.transaction,
                fromToken: lastSwapQuote.fromSymbol,
                toToken: lastSwapQuote.toSymbol,
                amount: lastSwapQuote.fromAmount,
              } : {}),
            } as any
            result = { status: 'preview_ready' }

          } else if (block.name === 'get_wallet_holdings') {
            if (!walletAddress || !isAddress(walletAddress)) {
              result = { error: 'No wallet connected. Ask the user to connect their wallet first.' }
            } else {
              try {
                const balances = await fetchWalletBalances(walletAddress)
                result = {
                  balances,
                  note: 'Live on-chain balances. USD prices are not available yet.',
                }
              } catch {
                result = { error: 'Could not fetch balances from the chain. The RPC may be temporarily unavailable.' }
              }
            }

          } else if (block.name === 'get_swap_quote') {
            const { fromToken, toToken, amount } = block.input as {
              fromToken: string
              toToken: string
              amount: string
            }
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

          } else {
            result = callStubTool(block.name, block.input)
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          })
        }

        anthropicMessages.push({ role: 'user', content: toolResults })
        continue
      }

      // Unexpected stop reason — take whatever text we have and exit
      responseText = textBlocks.map((b) => b.text).join(' ').trim()
      break
    }

    const fallback =
      "I'm not sure how to help with that. Try asking me what you hold, to put idle funds to work, swap tokens, open a perps position, buy a stock token, or deposit into a vault."

    return NextResponse.json({ text: responseText || fallback, action })
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
