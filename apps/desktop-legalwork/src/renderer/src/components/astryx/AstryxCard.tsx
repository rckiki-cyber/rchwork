import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface AstryxCardProps {
  children: ReactNode
  className?: string
}

export function AstryxCard({ children, className }: AstryxCardProps): ReactElement {
  return (
    <div
      className={cn(
        'rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25',
        className
      )}
    >
      {children}
    </div>
  )
}

export interface AstryxCardHeaderProps {
  children: ReactNode
  className?: string
}

export function AstryxCardHeader({ children, className }: AstryxCardHeaderProps): ReactElement {
  return (
    <div className={cn('border-b border-ds-border-muted px-5 py-3', className)}>
      {children}
    </div>
  )
}

export interface AstryxCardTitleProps {
  children: ReactNode
  className?: string
}

export function AstryxCardTitle({ children, className }: AstryxCardTitleProps): ReactElement {
  return <h3 className={cn('text-[16px] font-semibold text-ds-ink', className)}>{children}</h3>
}

export interface AstryxCardContentProps {
  children: ReactNode
  className?: string
}

export function AstryxCardContent({ children, className }: AstryxCardContentProps): ReactElement {
  return <div className={cn('px-5 py-4', className)}>{children}</div>
}

export interface AstryxCardFooterProps {
  children: ReactNode
  className?: string
}

export function AstryxCardFooter({ children, className }: AstryxCardFooterProps): ReactElement {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 border-t border-ds-border-muted px-5 py-3',
        className
      )}
    >
      {children}
    </div>
  )
}
