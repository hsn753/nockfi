# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev        # Start dev server at localhost:3000
pnpm build      # Production build (TypeScript errors are ignored — see next.config.mjs)
pnpm lint       # ESLint
```

No test suite is configured.

## Stack

- **Next.js 16** (App Router) with React 19
- **Tailwind CSS v4** — config is CSS-first via `globals.css`, not a `tailwind.config.*` file
- **shadcn/ui** — components live in `components/ui/`, installed via `shadcn` CLI
- **lucide-react** for icons, `tw-animate-css` for animation utilities
- **pnpm** as the package manager

## Architecture

This is a pure front-end demo app. There is no backend, API, or database. All state is held in React and seeded from `components/nock/data.ts`.

### State ownership

`NockApp` (`components/nock/nock-app.tsx`) is the single stateful root. It owns:
- `messages` — chat thread between the user and Robin
- `attention` — dashboard alerts requiring user action
- `positions` — active portfolio positions
- `activity` — transaction history log
- `addedValue` — numeric delta applied to the base portfolio total

All child components are stateless and receive data and callbacks as props.

### The "Draw / Loose" action flow

When Robin proposes an action it attaches an `ActionPreview` object to a chat message. The user can:
1. **Draw** — marks status `reviewing`, shows a safety disclosure
2. **Loose** — marks status `confirming`, then after a 1.2 s delay marks it `executed`, appends a new `Position` and `ActivityItem` to state, clears the matching `AttentionItem`, and sends a confirmation chat message

The word choices ("Draw", "Loose") are intentional product terminology, not bugs.

### `buildRobinReply` in `data.ts`

This function is the simulated AI. It pattern-matches on keywords in the user's input and returns a hardcoded `ChatMessage` with an `ActionPreview`. Adding new agent response paths means adding another `if` branch here.

### Key types (all in `data.ts`)

| Type | Purpose |
|---|---|
| `AgentId` | Union of `'yield' \| 'perps' \| 'swap' \| 'vault'` |
| `ActionPreview` | Proposed action card with status state machine |
| `ChatMessage` | Discriminated union on `role: 'user' \| 'robin'` |
| `Position` / `AttentionItem` / `ActivityItem` | Dashboard data shapes |

### Layout

Desktop: fixed sidebar (left) + chat panel (center) + dashboard panel (right, 280px/320px). Mobile: top bar + single-panel main + bottom nav + slide-in drawer sidebar.

The design uses a dark-only theme. Colors are defined as CSS custom properties on `:root` in `globals.css`. Primary accent is teal (`#5eead4`).
