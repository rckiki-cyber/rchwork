import type { ReactElement, ReactNode, InputHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export interface AstryxInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  icon?: ReactNode
  invalid?: boolean
  clearable?: boolean
  onClear?: () => void
  containerClassName?: string
  endAdornment?: ReactNode
}

export function AstryxInput({
  label,
  error,
  hint,
  icon,
  invalid,
  clearable,
  onClear,
  className,
  containerClassName,
  endAdornment,
  ...props
}: AstryxInputProps): ReactElement {
  const showClear = clearable && props.value && String(props.value).length > 0 && !props.disabled
  const hasError = Boolean(error) || invalid

  return (
    <div className={cn('grid gap-1.5', className)}>
      {label ? (
        <label className="text-[13px] font-medium text-ds-ink">
          {label}
          {props.required ? <span className="ml-0.5 text-red-500">*</span> : null}
        </label>
      ) : null}
      <div
        className={cn(
          'flex items-stretch overflow-hidden rounded-xl border bg-ds-main/55 shadow-sm transition focus-within:border-accent/45 focus-within:ring-2 focus-within:ring-accent/15',
          hasError
            ? 'border-amber-300 focus-within:border-amber-400 focus-within:ring-amber-200'
            : 'border-ds-border',
          containerClassName
        )}
      >
        {icon ? (
          <div className="flex items-center pl-3 text-ds-muted">{icon}</div>
        ) : null}
        <input
          className="h-10 min-w-0 flex-1 bg-transparent px-3 py-2 text-[14px] text-ds-ink outline-none placeholder:text-ds-faint disabled:cursor-not-allowed disabled:opacity-60"
          {...props}
        />
        {showClear ? (
          <button
            type="button"
            onClick={onClear}
            className="flex items-center px-2 text-ds-muted transition hover:text-ds-ink"
            aria-label="Clear"
          >
            ×
          </button>
        ) : null}
        {endAdornment ? (
          <div className="flex shrink-0 items-center pr-1">{endAdornment}</div>
        ) : null}
      </div>
      {error ? <p className="text-[12px] text-red-500">{error}</p> : null}
      {hint && !error ? <p className="text-[12px] text-ds-muted">{hint}</p> : null}
    </div>
  )
}
