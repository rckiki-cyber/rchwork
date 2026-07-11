import type { ReactElement } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import type { NormalizedThread } from '../../agent/types'

export type KnowledgeBaseChatSidebarProps = {
  threads: NormalizedThread[]
  activeThreadId: string | null
  onSelectThread: (id: string) => void
  onDeleteThread: (id: string) => void
}

function formatThreadTime(updatedAt: string | undefined, locale: string): string {
  if (!updatedAt) return ''
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function KnowledgeBaseChatSidebar({
  threads,
  activeThreadId,
  onSelectThread,
  onDeleteThread
}: KnowledgeBaseChatSidebarProps): ReactElement {
  const { t, i18n } = useTranslation('common')

  const sortedThreads = useMemo(
    () =>
      [...threads].sort((a, b) => {
        const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
        const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
        return bTime - aTime
      }),
    [threads]
  )

  const locale = i18n.language === 'zh' || i18n.language.startsWith('zh-') ? 'zh-CN' : 'en-US'

  return (
    <div className="ds-no-drag flex h-full min-h-0 flex-col">
      <div className="border-b border-[var(--ds-sidebar-divider)] px-4 py-3">
        <h3 className="text-[13px] font-medium text-[var(--ds-ink)]">{t('knowledgeBaseChatRecords')}</h3>
        <p className="mt-0.5 text-[11px] text-[var(--ds-faint)]">
          {t('knowledgeBaseChatRecordsCount', { count: threads.length })}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {sortedThreads.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-[var(--ds-faint)]">
            {t('knowledgeBaseChatEmpty')}
            <br />
            {t('knowledgeBaseChatEmptyHint')}
          </div>
        ) : (
          sortedThreads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => onSelectThread(thread.id)}
              className={`group relative w-full rounded-[8px] px-3 py-2 text-left text-[13px] transition-colors ${
                activeThreadId === thread.id
                  ? 'bg-[var(--ds-sidebar-row-active)] text-[var(--ds-ink)]'
                  : 'text-[var(--ds-ink)] hover:bg-[var(--ds-sidebar-row-hover)]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate">{thread.title || t('knowledgeBaseChatUntitled')}</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-[10px] text-[var(--ds-faint)]">
                  {formatThreadTime(thread.updatedAt, locale)}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm(t('knowledgeBaseChatDeleteConfirm'))) {
                      onDeleteThread(thread.id)
                    }
                  }}
                  className="rounded p-1 text-[var(--ds-faint)] opacity-0 transition-opacity hover:bg-[var(--ds-sidebar-row-hover)] hover:text-red-400 group-hover:opacity-100"
                  title={t('knowledgeBaseChatDeleteRecord')}
                >
                  <Trash2 className="h-3 w-3" strokeWidth={1.75} />
                </button>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
