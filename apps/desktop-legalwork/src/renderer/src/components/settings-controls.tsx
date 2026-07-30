import type { ReactElement, ReactNode } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { AstryxButton } from './astryx/AstryxButton'
import { AstryxInput } from './astryx/AstryxInput'
import { AstryxToggle } from './astryx/AstryxToggle'

export type InlineNotice = {
  tone: 'success' | 'error' | 'info'
  message: string
}

export function SecretInput({
  value,
  onChange,
  visible,
  onToggleVisibility,
  placeholder,
  autoComplete,
  invalid = false,
  showLabel,
  hideLabel,
  className = ''
}: {
  value: string
  onChange: (value: string) => void
  visible: boolean
  onToggleVisibility: () => void
  placeholder?: string
  autoComplete?: string
  invalid?: boolean
  showLabel: string
  hideLabel: string
  className?: string
}): ReactElement {
  return (
    <AstryxInput
      type={visible ? 'text' : 'password'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      autoComplete={autoComplete}
      className={className}
      invalid={invalid}
      endAdornment={
        <AstryxButton
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={visible ? hideLabel : showLabel}
          title={visible ? hideLabel : showLabel}
          onClick={onToggleVisibility}
        >
          {visible ? (
            <EyeOff className="h-4 w-4" strokeWidth={1.75} />
          ) : (
            <Eye className="h-4 w-4" strokeWidth={1.75} />
          )}
        </AstryxButton>
      }
    />
  )
}

export function SectionJumpButton({
  label,
  onClick
}: {
  label: string
  onClick: () => void
}): ReactElement {
  return (
    <AstryxButton variant="ghost" size="sm" onClick={onClick}>
      {label}
    </AstryxButton>
  )
}

export function InlineNoticeView({
  notice
}: {
  notice: InlineNotice
}): ReactElement {
  const className =
    notice.tone === 'error'
      ? 'border-red-300/80 bg-red-50 text-red-800 dark:border-red-800/70 dark:bg-red-950/25 dark:text-red-200'
      : notice.tone === 'success'
        ? 'border-emerald-300/80 bg-emerald-50 text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/25 dark:text-emerald-200'
        : 'border-ds-border bg-ds-main/50 text-ds-muted'

  return (
    <div className={`rounded-xl border px-3 py-2 text-[12.5px] leading-5 ${className}`}>
      {notice.message}
    </div>
  )
}

export function SettingsCard({
  title,
  children,
  className = ''
}: {
  title: string
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <section
      data-control-hover-root
      className={`rounded-2xl border border-ds-border bg-ds-card/95 shadow-sm shadow-black/5 dark:shadow-black/25 ${className}`}
    >
      <div className="border-b border-ds-border-muted px-5 py-3">
        <h2 className="text-[16px] font-semibold text-ds-ink">{title}</h2>
      </div>
      <div className="divide-y divide-ds-border-muted px-2 py-1">{children}</div>
    </section>
  )
}

export function SettingRow({
  title,
  description,
  control,
  wideControl = false
}: {
  title: string
  description?: string
  control: ReactNode
  wideControl?: boolean
}): ReactElement {
  return (
    <div
      data-control-hover-target
      className={`flex gap-3 rounded-[12px] px-3 py-4 hover:z-[3] focus-within:z-[3] ${
        wideControl
          ? 'flex-col sm:gap-3.5'
          : 'flex-col sm:flex-row sm:items-start sm:justify-between sm:gap-8'
      }`}
    >
      <div className={`min-w-0 ${wideControl ? 'w-full max-w-none shrink-0' : 'flex-1'}`}>
        <div className="text-[14px] font-semibold text-ds-ink">{title}</div>
        {description ? (
          <p className="mt-0.5 text-[13px] leading-relaxed text-ds-muted">{description}</p>
        ) : null}
      </div>
      <div className={`w-full min-w-0 ${wideControl ? '' : 'sm:max-w-[420px]'}`}>{control}</div>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled = false
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): ReactElement {
  return <AstryxToggle checked={checked} onChange={onChange} disabled={disabled} />
}
