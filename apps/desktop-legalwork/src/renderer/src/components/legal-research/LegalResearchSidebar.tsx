import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, CircleAlert, LoaderCircle, Trash2 } from 'lucide-react'
import type { ResearchRecord } from './useLegalResearch'

export type LegalResearchSidebarProps = {
  records: ResearchRecord[]
  activeRecordId: string | null
  onSelectRecord: (id: string) => void
  onDeleteRecord: (id: string) => void
  onClearHistory: () => void
  onStopResearch: () => void
}

export function LegalResearchSidebar({
  records,
  activeRecordId,
  onSelectRecord,
  onDeleteRecord,
  onClearHistory,
  onStopResearch
}: LegalResearchSidebarProps): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div
      data-sidebar-hover-root
      className="ds-no-drag ds-subfeature-controls relative flex h-full min-h-0 flex-col overflow-hidden"
    >
      <span aria-hidden data-sidebar-hover-indicator />
      <div className="border-b border-[var(--ds-sidebar-divider)] px-4 py-3">
        <h3 className="text-[13px] font-medium text-[var(--ds-ink)]">{t('legalResearchHistory')}</h3>
        <p className="mt-0.5 text-[11px] text-[var(--ds-faint)]">
          {t('legalResearchHistoryCount', { count: records.length })}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {records.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-[var(--ds-faint)]">
            {t('legalResearchEmptyHistory')}
            <br />
            {t('legalResearchEmptyHistoryHint')}
          </div>
        ) : (
          records.map((record) => (
            <div key={record.id} className="group relative">
              <button
                type="button"
                data-sidebar-hover-target
                data-sidebar-active={activeRecordId === record.id ? 'true' : undefined}
                onClick={() => onSelectRecord(record.id)}
                className={`relative w-full rounded-[12px] px-3 py-2.5 pr-10 text-left text-[13px] transition-colors ${
                  activeRecordId === record.id
                    ? 'bg-[var(--ds-sidebar-row-active)] text-[var(--ds-ink)]'
                    : 'text-[var(--ds-ink)] hover:bg-[var(--ds-sidebar-row-hover)]'
                }`}
              >
                <div className="flex items-center gap-2">
                  {record.status === 'running' ? (
                    <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--ds-accent)]" strokeWidth={1.8} />
                  ) : record.status === 'error' ? (
                    <CircleAlert className="h-3.5 w-3.5 shrink-0 text-[var(--ds-danger)]" strokeWidth={1.8} />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--ds-success)]" strokeWidth={1.8} />
                  )}
                  <span className="flex-1 truncate font-medium">{record.query}</span>
                </div>
                <div className="mt-1 pl-[22px]">
                  <span className="text-[10px] text-[var(--ds-faint)]">{record.timestamp}</span>
                </div>
                {record.error ? (
                  <div className="mt-1 truncate pl-[22px] text-[10px] text-[var(--ds-danger)]">{record.error}</div>
                ) : null}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  if (record.status === 'running') onStopResearch()
                  onDeleteRecord(record.id)
                }}
                className="absolute right-2 top-1/2 z-[3] inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[12px] text-[var(--ds-faint)] opacity-0 transition hover:bg-[var(--ds-danger-soft)] hover:text-[var(--ds-danger)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]/30 group-hover:opacity-100"
                title={t('legalResearchDeleteRecord')}
                aria-label={t('legalResearchDeleteRecord')}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>
          ))
        )}
      </div>

      {records.length > 0 && (
        <div className="border-t border-[var(--ds-sidebar-divider)] p-2">
          <button
            type="button"
            data-sidebar-hover-target
            onClick={onClearHistory}
            className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[11px] text-[var(--ds-faint)] transition-colors hover:bg-[var(--ds-sidebar-row-hover)] hover:text-[var(--ds-ink)]"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            {t('legalResearchClearHistory')}
          </button>
        </div>
      )}
    </div>
  )
}
