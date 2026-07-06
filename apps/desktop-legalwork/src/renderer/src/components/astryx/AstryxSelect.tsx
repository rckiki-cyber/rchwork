import type { ReactElement, ReactNode, SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface AstryxSelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface AstryxSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  hint?: string
  options: AstryxSelectOption[]
}

export function AstryxSelect({
  label,
  error,
  hint,
  options,
  className,
  ...props
}: AstryxSelectProps): ReactElement {
  return (
    <div className={cn('grid gap-1.5', className)}>
      {label ? (
        <label className="text-[13px] font-medium text-ds-ink">
          {label}
          {props.required ? <span className="ml-0.5 text-red-500">*</span> : null}
        </label>
      ) : null}
      <div className="relative">
        <select
          className={cn(
            'h-10 w-full appearance-none rounded-xl border bg-ds-main/55 px-3 pr-9 text-[14px] text-ds-ink outline-none transition focus:border-accent/45 focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-60',
            error ? 'border-amber-300 focus:border-amber-400 focus:ring-amber-200' : 'border-ds-border'
          )}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ds-muted"
          strokeWidth={1.8}
        />
      </div>
      {error ? <p className="text-[12px] text-red-500">{error}</p> : null}
      {hint && !error ? <p className="text-[12px] text-ds-muted">{hint}</p> : null}
    </div>
  )
}
