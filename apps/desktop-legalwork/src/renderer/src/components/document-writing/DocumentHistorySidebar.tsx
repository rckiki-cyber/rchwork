import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, FileText, Loader2, Search, Trash2, AlertCircle } from 'lucide-react'
import type {
  DocumentHistoryRecord,
  DocumentHistorySummary
} from '../../../../shared/document-history'

type Props = {
  onRestore: (record: DocumentHistoryRecord) => void
  onRefreshSignal?: number
}

export function DocumentHistorySidebar({ onRestore, onRefreshSignal }: Props): ReactElement {
  const { t } = useTranslation('common')
  const [summaries, setSummaries] = useState<DocumentHistorySummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [loadingRecordId, setLoadingRecordId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await window.dsGui.listDocumentHistory()
      setSummaries(list)
    } catch {
      setError(t('documentWritingHistoryLoadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadList()
  }, [loadList, onRefreshSignal])

  const handleRestore = useCallback(
    async (summary: DocumentHistorySummary) => {
      setLoadingRecordId(summary.id)
      try {
        const record = await window.dsGui.getDocumentHistoryRecord(summary.id)
        if (record) {
          onRestore(record)
        } else {
          setError(t('documentWritingHistoryRecordNotFound'))
        }
      } catch {
        setError(t('documentWritingHistoryLoadError'))
      } finally {
        setLoadingRecordId(null)
      }
    },
    [onRestore, t]
  )

  const handleDelete = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      setDeletingId(id)
      try {
        await window.dsGui.deleteDocumentHistoryRecord(id)
        setSummaries((prev) => prev.filter((s) => s.id !== id))
      } catch {
        setError(t('documentWritingHistoryDeleteError'))
      } finally {
        setDeletingId(null)
      }
    },
    [t]
  )

  const filtered = searchQuery
    ? summaries.filter((s) => s.templateName.toLowerCase().includes(searchQuery.toLowerCase()))
    : summaries

  const catLabel = (cat: string): string => {
    switch (cat) {
      case 'litigation':
        return t('documentWritingLitigation')
      case 'non-litigation':
        return t('documentWritingNonLitigation')
      case 'custom':
        return t('documentWritingMyTemplates')
      default:
        return cat
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="ds-no-drag shrink-0 px-4 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-[var(--ds-accent)]" strokeWidth={1.75} />
          <h2 className="text-[15px] font-semibold text-[var(--ds-ink)]">
            {t('documentWritingHistory')}
          </h2>
          {!loading && (
            <span className="ml-auto text-[12px] text-[var(--ds-faint)]">
              {t('documentWritingHistoryCount', { count: summaries.length })}
            </span>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="ds-no-drag shrink-0 px-4 pb-3">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('documentWritingHistorySearchPlaceholder')}
            className="w-full rounded-[8px] border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)] px-3 py-1.5 pl-9 text-[13px] text-[var(--ds-ink)] placeholder-[var(--ds-faint)] outline-none transition focus:border-[var(--ds-accent)] focus:ring-1 focus:ring-[var(--ds-accent)]"
          />
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ds-faint)]" />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[4px] p-0.5 text-[var(--ds-faint)] hover:text-[var(--ds-ink)]"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-[6px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <div className="mt-8 flex flex-col items-center gap-2 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ds-faint)]" />
            <p className="text-[13px] text-[var(--ds-faint)]">{t('loading')}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-2 text-center">
            <FileText className="h-8 w-8 text-[var(--ds-faint)]" strokeWidth={1.5} />
            <p className="text-[13px] text-[var(--ds-faint)]">
              {searchQuery ? t('documentWritingHistoryNoSearchResults') : t('documentWritingHistoryEmpty')}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {filtered.map((s) => (
              <button
                key={s.id}
                type="button"
                data-sidebar-hover-target
                onClick={() => void handleRestore(s)}
                disabled={loadingRecordId === s.id || deletingId === s.id}
                className="group relative flex w-full items-start gap-3 rounded-[12px] px-3 py-2.5 text-left transition hover:bg-[color-mix(in_srgb,var(--ds-sidebar-field-focus)_56%,transparent)] disabled:opacity-60 dark:hover:bg-white/[0.055]"
              >
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ds-accent)]" strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-[var(--ds-ink)]">{s.templateName}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--ds-faint)]">
                    <span>{catLabel(s.templateCategory)}</span>
                    {s.materialCount > 0 && (
                      <span>
                        {t('documentWritingHistoryMaterialCount', { count: s.materialCount })}
                      </span>
                    )}
                    {s.hasInstructions && <span>{t('documentWritingHistoryHasInstructions')}</span>}
                    <span className="ml-auto">{formatTime(s.createdAt)}</span>
                  </div>
                </div>
                {loadingRecordId === s.id ? (
                  <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-[var(--ds-faint)]" />
                ) : (
                  <button
                    type="button"
                    onClick={(e) => void handleDelete(s.id, e)}
                    disabled={deletingId === s.id}
                    className="absolute right-1.5 top-2 rounded-[4px] p-0.5 text-[var(--ds-faint)] opacity-0 hover:text-red-500 group-hover:opacity-100"
                  >
                    {deletingId === s.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    )}
                  </button>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hour = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${month}-${day} ${hour}:${min}`
  } catch {
    return iso.slice(0, 16)
  }
}
