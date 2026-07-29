import type { ReactElement, ButtonHTMLAttributes } from 'react'
import { Check, Minus } from 'lucide-react'
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
        data-state={checked ? 'checked' : 'unchecked'}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 focus-visible:ring-offset-2 focus-visible:ring-offset-ds-main',
          checked
            ? 'border-accent bg-accent shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]'
            : 'border-ds-border-strong bg-ds-subtle',
          disabled && 'cursor-not-allowed'
        )}
        {...props}
      >
        <span
          className={cn(
            'absolute left-0.5 top-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.28)] ring-1 ring-black/10 transition-transform duration-200',
            checked ? 'translate-x-5' : 'translate-x-0'
          )}
        >
          {checked ? (
            <Check className="h-3 w-3 text-accent" strokeWidth={3} aria-hidden="true" />
          ) : (
            <Minus className="h-3 w-3 text-slate-500" strokeWidth={3} aria-hidden="true" />
          )}
        </span>
      </button>
    </label>
  )
}
