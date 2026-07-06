import type { ReactElement, ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export interface AstryxIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  'aria-label': string
  title?: string
}

export function AstryxIconButton({
  className,
  children,
  ...props
}: AstryxIconButtonProps): ReactElement {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg text-ds-muted transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-45 hover:bg-ds-hover hover:text-ds-ink',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}
