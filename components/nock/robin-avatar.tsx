import { Target } from 'lucide-react'
import { cn } from '@/lib/utils'

export function RobinAvatar({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground',
        className,
      )}
      aria-hidden="true"
    >
      <Target className="size-1/2" strokeWidth={2} />
    </span>
  )
}
