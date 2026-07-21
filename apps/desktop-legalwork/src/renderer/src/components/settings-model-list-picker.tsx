import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Check, ChevronDown, Loader2, Plus, RefreshCw } from 'lucide-react'
import { InlineNoticeView } from './settings-controls'

type Translate = (key: string, options?: Record<string, unknown>) => string

const FETCH_DEBOUNCE_MS = 800

/**
 * Model picker for a model-provider profile: automatically fetches the
 * provider's /v1/models list once an API key is present, and lets the user
 * check which models to enable. Manually entered model IDs are preserved.
 */
export function ModelListPicker({
  providerId,
  endpointFormat,
  baseUrl,
  apiKey,
  models,
  onChange,
  t
}: {
  providerId: string
  endpointFormat?: string
  baseUrl: string
  apiKey: string
  models: string[]
  onChange: (models: string[]) => void
  t: Translate
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedIds, setFetchedIds] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [customId, setCustomId] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const requestSeq = useRef(0)

  const fetchModels = async (): Promise<void> => {
    if (!apiKey.trim() || !baseUrl.trim()) return
    if (typeof window.dsGui?.fetchEndpointModels !== 'function') return
    const seq = ++requestSeq.current
    setLoading(true)
    setError(null)
    try {
      const result = await window.dsGui.fetchEndpointModels(baseUrl, apiKey, {
        providerId,
        endpointFormat
      })
      if (seq !== requestSeq.current) return
      if (result.ok) {
        setFetchedIds(result.modelIds)
      } else {
        setError(result.message)
      }
    } catch (e) {
      if (seq !== requestSeq.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }

  // Auto-fetch whenever the credentials change (debounced).
  useEffect(() => {
    requestSeq.current += 1
    setFetchedIds([])
    setError(null)
    setLoading(false)
    setFilter('')
    if (!apiKey.trim() || !baseUrl.trim()) return
    const timer = setTimeout(() => void fetchModels(), FETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, endpointFormat, baseUrl, apiKey])

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const selected = useMemo(() => new Set(models.map((id) => id.trim()).filter(Boolean)), [models])
  const allIds = useMemo(() => {
    const fetched = new Set(fetchedIds)
    const customSelected = [...selected].filter((id) => !fetched.has(id))
    return [...fetchedIds, ...customSelected]
  }, [fetchedIds, selected])
  const visibleIds = useMemo(() => {
    const query = filter.trim().toLowerCase()
    return query ? allIds.filter((id) => id.toLowerCase().includes(query)) : allIds
  }, [allIds, filter])

  const toggleModel = (id: string): void => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next].sort((a, b) => a.localeCompare(b)))
  }

  const addCustomModel = (): void => {
    const id = customId.trim()
    if (!id || selected.has(id)) {
      setCustomId('')
      return
    }
    onChange([...selected, id].sort((a, b) => a.localeCompare(b)))
    setCustomId('')
  }

  return (
    <div ref={rootRef} className="relative w-full min-w-0 md:max-w-md">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between gap-2 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm transition hover:bg-ds-hover"
        >
          <span className="min-w-0 truncate">
            {selected.size === 0
              ? t('modelListNoneSelected')
              : t('modelListSelectedSummary', { selected: selected.size, total: allIds.length })}
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 transition ${open ? 'rotate-180' : ''}`} />
        </button>
        <button
          type="button"
          onClick={() => void fetchModels()}
          disabled={loading || !apiKey.trim() || !baseUrl.trim()}
          title={t('modelListRefresh')}
          className="shrink-0 rounded-xl border border-ds-border bg-ds-card p-2 text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      </div>

      {error ? (
        <div className="mt-2">
          <InlineNoticeView notice={{ tone: 'error', message: `${t('modelListFetchFailed')}: ${error}` }} />
        </div>
      ) : null}

      {open ? (
        <div className="absolute z-20 mt-2 w-full rounded-xl border border-ds-border bg-ds-card shadow-lg">
          <div className="border-b border-ds-border p-2">
            <input
              className="w-full rounded-lg border border-ds-border bg-ds-main/60 px-2.5 py-1.5 text-[13px] text-ds-ink focus:border-accent/40 focus:outline-none"
              placeholder={t('modelListFilterPlaceholder')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="max-h-60 overflow-y-auto p-1.5">
            {visibleIds.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12.5px] text-ds-faint">
                {loading ? t('modelListFetching') : t('modelListEmpty')}
              </p>
            ) : (
              visibleIds.map((id) => {
                const checked = selected.has(id)
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggleModel(id)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ds-ink transition hover:bg-ds-hover"
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        checked ? 'border-accent bg-accent text-white' : 'border-ds-border bg-ds-card'
                      }`}
                    >
                      {checked ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span className="min-w-0 truncate font-mono text-[12.5px]">{id}</span>
                  </button>
                )
              })
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-ds-border p-2">
            <input
              className="w-full rounded-lg border border-ds-border bg-ds-main/60 px-2.5 py-1.5 font-mono text-[12.5px] text-ds-ink focus:border-accent/40 focus:outline-none"
              placeholder={t('modelListAddPlaceholder')}
              value={customId}
              onChange={(e) => setCustomId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addCustomModel()
              }}
            />
            <button
              type="button"
              onClick={addCustomModel}
              disabled={!customId.trim()}
              className="shrink-0 rounded-lg border border-ds-border bg-ds-card p-1.5 text-ds-ink transition hover:bg-ds-hover disabled:opacity-50"
              title={t('modelListAdd')}
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
