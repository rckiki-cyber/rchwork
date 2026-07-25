import { useMemo, useState, type ReactElement } from 'react'
import { CheckCircle2, CircleAlert, History, LayoutDashboard, Search, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLearningIterationStore } from '../../learning-iteration/learning-iteration-store'

function statusIcon(status: string): ReactElement {
  if (status === 'failed') return <CircleAlert className="h-3.5 w-3.5 text-red-500" />
  if (status === 'rolled_back') return <Undo2 className="h-3.5 w-3.5 text-amber-500" />
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
}

export function LearningIterationSidebar(): ReactElement {
  const { t } = useTranslation('common')
  const records = useLearningIterationStore((state) => state.records)
  const selectedId = useLearningIterationStore((state) => state.selectedId)
  const select = useLearningIterationStore((state) => state.select)
  const [query, setQuery] = useState('')
  const visibleRecords = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return records
    return records.filter((record) => record.displayName.toLocaleLowerCase().includes(normalized))
  }, [query, records])

  return (
    <div className="ds-no-drag flex min-h-0 flex-1 flex-col px-1">
      <button
        type="button"
        onClick={() => void select(null)}
        className={`flex min-h-[38px] items-center gap-2.5 rounded-[9px] px-3 text-[13.5px] font-semibold transition ${
          selectedId === null
            ? 'bg-[var(--ds-sidebar-row-active)] text-ds-ink shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)]'
            : 'text-ds-muted hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-ink'
        }`}
      >
        <LayoutDashboard className="h-4 w-4" strokeWidth={1.8} />
        {t('learningIterationOverview')}
      </button>

      <div className="relative mx-1 mt-3">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-ds-faint" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('learningIterationSearch')}
          className="h-8 w-full rounded-[8px] border border-ds-border bg-ds-card pl-8 pr-2 text-[12px] text-ds-ink outline-none transition placeholder:text-ds-faint focus:border-accent/50"
        />
      </div>

      <div className="mt-4 flex items-center gap-2 px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ds-faint">
        <History className="h-3.5 w-3.5" />
        {t('learningIterationRecords')}
      </div>
      <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {visibleRecords.map((record) => (
          <button
            key={record.id}
            type="button"
            onClick={() => void select(record.id)}
            className={`flex w-full items-start gap-2 rounded-[9px] px-2.5 py-2.5 text-left transition ${
              selectedId === record.id
                ? 'bg-[var(--ds-sidebar-row-active)] text-ds-ink'
                : 'text-ds-muted hover:bg-[var(--ds-sidebar-row-hover)] hover:text-ds-ink'
            }`}
          >
            <span className="mt-0.5 shrink-0">{statusIcon(record.status)}</span>
            <span className="min-w-0 text-[12.5px] leading-[1.45]">{record.displayName}</span>
          </button>
        ))}
        {visibleRecords.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12px] leading-5 text-ds-faint">
            {query ? t('learningIterationNoSearchResults') : t('learningIterationNoRecords')}
          </div>
        ) : null}
      </div>
    </div>
  )
}
