import type { ReactElement, TextareaHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export interface AstryxTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  hint?: string
}

export function AstryxTextarea({
  label,
  error,
  hint,
  className,
  ...props
}: AstryxTextareaProps): ReactElement {
  return (
    <div className={cn('grid gap-1.5', className)}>
      {label ? (
        <label className="text-[13px] font-medium text-ds-ink">
          {label}
          {props.required ? <span className="ml-0.5 text-red-500">*</span> : null}
        </label>
      ) : null}
      <textarea
        className={cn(
          'min-h-[108px] w-full resize-y rounded-xl border bg-ds-main/55 px-3 py-2.5 text-[14px] leading-6 text-ds-ink outline-none transition placeholder:text-ds-faint focus:border-accent/45 focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-60',
          error ? 'border-amber-300 focus:border-amber-400 focus:ring-amber-200' : 'border-ds-border'
        )}
        {...props}
      />
      {error ? <p className="text-[12px] text-red-500">{error}</p> : null}
      {hint && !error ? <p className="text-[12px] text-ds-muted">{hint}</p> : null}
    </div>
  )
}
