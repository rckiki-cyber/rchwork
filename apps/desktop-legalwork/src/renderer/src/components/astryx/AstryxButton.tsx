import type { ReactElement, ReactNode, ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

export interface AstryxButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  children: ReactNode
}

export function AstryxButton({
  variant = 'default',
  size = 'md',
  type = 'button',
  className,
  children,
  ...props
}: AstryxButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-45',
        // variants
        variant === 'default' &&
          'bg-accent text-white shadow-sm hover:opacity-95 active:opacity-90',
        variant === 'secondary' &&
          'border border-ds-border bg-ds-card text-ds-ink shadow-sm hover:bg-ds-hover',
        variant === 'outline' &&
          'border border-ds-border bg-transparent text-ds-ink hover:bg-ds-hover',
        variant === 'ghost' &&
          'bg-transparent text-ds-muted hover:bg-ds-hover hover:text-ds-ink',
        variant === 'danger' &&
          'bg-red-500 text-white shadow-sm hover:opacity-95 active:opacity-90',
        // sizes
        size === 'sm' && 'h-7 px-2.5 text-[12px]',
        size === 'md' && 'h-9 px-4 text-[13px]',
        size === 'lg' && 'h-10 px-5 text-[14px]',
        size === 'icon' && 'h-9 w-9 p-0 text-[13px]',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}
