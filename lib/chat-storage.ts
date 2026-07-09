import type { ChatMessage } from '@/components/nock/data'

// ── Domain types ──────────────────────────────────────────────────────────────

export type ConversationSummary = {
  id: string
  title: string
  createdAt: number // Unix ms
}

export type StoredConversation = ConversationSummary & {
  messages: ChatMessage[]
}

// ── Storage interface — swap this implementation for a real DB later ──────────

export interface ChatStorage {
  /** Return all conversations as lightweight summaries, newest first. */
  list(): ConversationSummary[]
  /** Fetch one full conversation (with messages) by ID. */
  get(id: string): StoredConversation | null
  /** Create or overwrite a conversation. */
  save(conversation: StoredConversation): void
  /** Permanently delete a conversation. */
  remove(id: string): void
}

// ── localStorage implementation ───────────────────────────────────────────────

const STORAGE_KEY = 'nock:conversations'

function readAll(): StoredConversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as StoredConversation[]
  } catch {
    return []
  }
}

function writeAll(conversations: StoredConversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
  } catch {
    // Quota exceeded or storage unavailable — fail silently.
  }
}

export const localChatStorage: ChatStorage = {
  list() {
    return readAll()
      .map(({ id, title, createdAt }) => ({ id, title, createdAt }))
      .sort((a, b) => b.createdAt - a.createdAt)
  },

  get(id) {
    return readAll().find((c) => c.id === id) ?? null
  },

  save(conversation) {
    const others = readAll().filter((c) => c.id !== conversation.id)
    writeAll([conversation, ...others])
  },

  remove(id) {
    writeAll(readAll().filter((c) => c.id !== id))
  },
}
