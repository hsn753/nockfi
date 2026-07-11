'use client'

import { useEffect, useRef, useState, Fragment } from 'react'
import { Send, SquarePen } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatMessage } from './data'
import { RobinAvatar } from './robin-avatar'
import { ActionPreviewCard } from './action-preview-card'
import { BridgeInfoCard } from './bridge-info-card'

type Props = {
  messages: ChatMessage[]
  onSend: (text: string) => void
  onDraw: (id: string) => void
  onLoose: (id: string) => void
  onNewChat: () => void
  isLoading?: boolean
}

const URL_PATTERN = /(https?:\/\/[^\s]+)/g

// Message text is plain (no markdown), but URLs Robin sends — e.g. a bridge or
// block explorer link — need to actually be tappable rather than inert text.
// split() with a capturing group always puts matches at odd indices, so index
// parity tells us which parts are URLs without re-testing a stateful global regex.
function renderMessageText(text: string) {
  const parts = text.split(URL_PATTERN)
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-primary"
      >
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  )
}

const MAX_INPUT_ROWS = 8

export function ChatPanel({ messages, onSend, onDraw, onLoose, onNewChat, isLoading }: Props) {
  const [value, setValue] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, isLoading])

  // Auto-grow the textarea with content, capped at MAX_INPUT_ROWS so a long paste
  // doesn't push the message list off screen.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '20')
    const maxHeight = lineHeight * MAX_INPUT_ROWS
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [value])

  function submit() {
    const text = value.trim()
    if (!text || isLoading) return
    onSend(text)
    setValue('')
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header */}
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-5 md:px-6">
        <RobinAvatar className="size-9" />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-[15px] font-semibold text-foreground">Robin</h1>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-primary" />
              Active
            </span>
          </div>
          <p className="text-xs text-muted-foreground">Your agent concierge</p>
        </div>
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
          className="flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        >
          <SquarePen className="size-4" strokeWidth={1.75} />
        </button>
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-7 px-5 py-8 md:px-6">
          {messages.length === 0 && !isLoading && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <RobinAvatar className="mb-4 size-14 opacity-60" />
              <p className="text-base font-medium text-foreground">How can I help?</p>
              <p className="mt-1.5 max-w-xs text-sm text-muted-foreground">
                Ask me to put your USDC to work, swap tokens, open a position, or explore your options.
              </p>
            </div>
          )}

          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[82%] rounded-2xl rounded-br-md border border-border bg-secondary px-4 py-3 text-[15px] leading-relaxed text-foreground">
                  {renderMessageText(m.text)}
                </div>
              </div>
            ) : (
              <div key={m.id} className="flex gap-3">
                <RobinAvatar className="mt-1 size-8 shrink-0" />
                <div className="min-w-0 max-w-[88%]">
                  <div className="rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3 text-[15px] leading-relaxed text-foreground">
                    {renderMessageText(m.text)}
                  </div>
                  {m.action && (
                    <ActionPreviewCard action={m.action} onDraw={onDraw} onLoose={onLoose} />
                  )}
                  {m.bridgeInfo && <BridgeInfoCard bridgeInfo={m.bridgeInfo} />}
                </div>
              </div>
            ),
          )}

          {/* Typing indicator */}
          {isLoading && (
            <div className="flex gap-3">
              <RobinAvatar className="mt-1 size-8 shrink-0" />
              <div className="rounded-2xl rounded-tl-md border border-border bg-card px-4 py-4">
                <div className="flex items-center gap-1.5">
                  <span className="size-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                  <span className="size-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                  <span className="size-2 animate-bounce rounded-full bg-muted-foreground" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border bg-background px-5 py-4 md:px-6">
        <div className="mx-auto flex max-w-2xl items-end gap-2.5">
          <div
            className={cn(
              'flex flex-1 items-center rounded-2xl border bg-card px-4 py-2.5 transition-colors',
              isLoading
                ? 'border-border opacity-50'
                : 'border-border focus-within:border-primary/50',
            )}
          >
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                // Shift+Enter (or Cmd/Ctrl+Enter) inserts a newline; plain Enter sends.
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault()
                  submit()
                }
              }}
              disabled={isLoading}
              placeholder={isLoading ? 'Robin is thinking...' : 'Ask Robin to do something'}
              aria-label="Message Robin"
              rows={1}
              className="max-h-40 min-h-[1.375rem] flex-1 resize-none bg-transparent text-[15px] leading-[1.375rem] text-foreground placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
            />
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim() || isLoading}
            aria-label="Send message"
            className={cn(
              'flex size-12 shrink-0 items-center justify-center rounded-2xl transition-colors',
              value.trim() && !isLoading
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-secondary text-muted-foreground',
            )}
          >
            <Send className="size-4" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  )
}
