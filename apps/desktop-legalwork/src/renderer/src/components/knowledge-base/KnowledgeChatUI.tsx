import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { SendIcon } from '../icons/SendIcon'

const KNOWLEDGE_CHAT_SIDEBAR_EXIT_MS = 320

export function useKnowledgeChatSidebarPresence(open: boolean): boolean {
  const [present, setPresent] = useState(open)

  useEffect(() => {
    if (open) {
      setPresent(true)
      return
    }
    if (!present) return

    const timer = window.setTimeout(() => setPresent(false), KNOWLEDGE_CHAT_SIDEBAR_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open, present])

  return present
}

type KnowledgeChatHeaderProps = {
  title: string
  contextLabel: string
  icon?: ReactNode
  actions?: ReactNode
}

export function KnowledgeChatHeader({
  title,
  contextLabel,
  icon,
  actions
}: KnowledgeChatHeaderProps): ReactElement {
  return (
    <div className="flex min-h-[58px] shrink-0 items-center justify-between gap-3 border-b border-ds-border bg-[color-mix(in_srgb,var(--ds-card-strong)_86%,transparent)] px-3.5 py-2.5 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[color-mix(in_srgb,var(--ds-accent)_18%,transparent)] bg-[color-mix(in_srgb,var(--ds-accent)_10%,transparent)] text-[var(--ds-accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.48)]">
          {icon ?? <Sparkles className="h-4 w-4" strokeWidth={1.8} />}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-[var(--ds-ink)]">
            {title}
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-[var(--ds-muted)]">
            {contextLabel}
          </div>
        </div>
      </div>
      {actions ? <div className="flex min-w-0 shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  )
}

type KnowledgeChatEmptyStateProps = {
  visual: ReactNode
  title: string
  description: string
  contextLabel: string
}

export function KnowledgeChatEmptyState({
  visual,
  title,
  description,
  contextLabel
}: KnowledgeChatEmptyStateProps): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-8">
      <div className="flex w-full max-w-[290px] flex-col items-center text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-[18px] border border-ds-border bg-[var(--ds-card-soft)] shadow-[var(--ds-shadow-card-soft)]">
          {visual}
        </div>
        <div className="text-[14px] font-semibold tracking-[-0.015em] text-[var(--ds-ink)]">
          {title}
        </div>
        <p className="mt-2 text-[12px] leading-[1.7] text-[var(--ds-muted)]">
          {description}
        </p>
        <div className="mt-4 max-w-full truncate rounded-full border border-ds-border bg-[var(--ds-card-soft)] px-3 py-1.5 text-[10.5px] text-[var(--ds-faint)]">
          {contextLabel}
        </div>
      </div>
    </div>
  )
}

type KnowledgeChatMessageProps = {
  role: 'user' | 'assistant' | 'reasoning' | 'tool'
  leading?: ReactNode
  timestamp?: number
  children: ReactNode
}

export function KnowledgeChatMessage({
  role,
  leading,
  timestamp,
  children
}: KnowledgeChatMessageProps): ReactElement {
  const user = role === 'user'
  const auxiliary = role === 'reasoning' || role === 'tool'

  return (
    <div className={`mb-4 flex items-start ${user ? 'justify-end' : 'justify-start'}`}>
      {!user && leading ? <div className="mr-2 mt-1 shrink-0">{leading}</div> : null}
      <div
        className={`max-w-[88%] px-3.5 py-2.5 !text-[13px] leading-[1.65] ${
          user
            ? 'ds-user-message-bubble rounded-[18px] rounded-br-[6px] bg-[var(--ds-userbubble)] text-[var(--ds-userbubbleFg)]'
            : auxiliary
              ? 'rounded-[14px] rounded-bl-[6px] border border-ds-border bg-[var(--ds-card-soft)] text-[var(--ds-muted)] shadow-sm'
              : 'rounded-[16px] rounded-bl-[6px] border border-[color-mix(in_srgb,var(--ds-border)_72%,transparent)] bg-[color-mix(in_srgb,var(--ds-card-soft)_72%,transparent)] text-[var(--ds-ink)] shadow-sm'
        }`}
      >
        {children}
        {timestamp ? (
          <div className={`mt-1 text-[10px] tabular-nums ${user ? 'opacity-[0.48]' : 'text-[var(--ds-faint)]'}`}>
            {new Date(timestamp).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit'
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

type KnowledgeChatComposerProps = {
  value: string
  placeholder: string
  disabled: boolean
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onSend: () => void
}

export function KnowledgeChatComposer({
  value,
  placeholder,
  disabled,
  onChange,
  onKeyDown,
  onSend
}: KnowledgeChatComposerProps): ReactElement {
  const [focused, setFocused] = useState(false)

  return (
    <div className="shrink-0 px-3 pb-3 pt-2">
      <div
        data-liquid-surface="composer"
        data-liquid-reactive
        className={`ds-composer-shell ds-chat-composer ds-frosted flex items-center gap-2 rounded-[20px] px-2.5 py-2 transition ${
          focused ? 'ds-chat-composer-focus' : ''
        }`}
      >
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          disabled={disabled}
          className="h-9 min-w-0 flex-1 bg-transparent px-1.5 text-[13px] text-[var(--ds-ink)] outline-none placeholder:text-[var(--ds-faint)] disabled:opacity-50"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--ds-userbubble)] text-[var(--ds-userbubbleFg)] shadow-sm transition duration-200 hover:scale-[1.03] hover:opacity-95 active:scale-[0.96] disabled:scale-100 disabled:opacity-35"
          aria-label="发送"
          title="发送"
        >
          <SendIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1.5 px-2 text-right text-[9.5px] text-[var(--ds-faint)]">
        Enter 发送
      </div>
    </div>
  )
}
