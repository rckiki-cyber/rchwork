import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface AstryxSegmentButtonProps {
  selected: boolean
  onClick: () => void
  children: ReactNode
  className?: string
  disabled?: boolean
}

export function AstryxSegmentButton({
  selected,
  onClick,
  children,
  className,
  disabled
}: AstryxSegmentButtonProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-9 min-w-0 rounded-xl border px-2.5 text-[12.5px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-45',
        selected
          ? 'border-ds-border-strong bg-ds-ink text-white shadow-sm'
          : 'border-ds-border bg-ds-main/55 text-ds-muted hover:bg-ds-hover hover:text-ds-ink',
        className
      )}
    >
      <span className="block truncate">{children}</span>
    </button>
  )
}

export interface AstryxSegmentGroupProps {
  children: ReactNode
  className?: string
}

export function AstryxSegmentGroup({ children, className }: AstryxSegmentGroupProps): ReactElement {
  return <div className={cn('flex flex-wrap gap-2', className)}>{children}</div>
}
