import { cn } from '@/lib/utils'
import { NockMark } from './nock-logo'

// Robin's avatar is the Nock mark — the brand's face throughout chat.
export function RobinAvatar({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full border border-border bg-secondary',
        className,
      )}
      aria-hidden="true"
    >
      <NockMark className="size-1/2" />
    </span>
  )
}
