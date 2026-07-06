import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../lib/cn'

export type BadgeVariant = 'default' | 'success' | 'error' | 'warning' | 'info' | 'skill'

export interface AstryxBadgeProps {
  variant?: BadgeVariant
  children: ReactNode
  className?: string
}

export function AstryxBadge({
  variant = 'default',
  children,
  className
}: AstryxBadgeProps): ReactElement {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-none',
        variant === 'default' && 'bg-ds-subtle text-ds-muted',
        variant === 'success' && 'bg-ds-success-soft text-ds-success',
        variant === 'error' && 'bg-ds-danger-soft text-ds-danger',
        variant === 'warning' && 'bg-ds-warning-soft text-amber-800 dark:text-amber-100',
        variant === 'info' && 'bg-accent/10 text-ds-ink',
        variant === 'skill' && 'bg-ds-skill-soft text-ds-skill',
        className
      )}
    >
      {children}
    </span>
  )
}
