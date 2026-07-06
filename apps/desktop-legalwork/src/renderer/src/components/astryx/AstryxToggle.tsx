import type { ReactElement, ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export interface AstryxToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}

export function AstryxToggle({
  checked,
  onChange,
  label,
  className,
  disabled,
  ...props
}: AstryxToggleProps): ReactElement {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ds-muted',
        disabled && 'cursor-not-allowed opacity-60',
        className
      )}
    >
      {label ? <span>{label}</span> : null}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30',
          checked ? 'bg-ds-ink' : 'bg-ds-border-strong',
          disabled && 'cursor-not-allowed'
        )}
        {...props}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition',
            checked ? 'left-[18px]' : 'left-0.5'
          )}
        />
      </button>
    </label>
  )
}
