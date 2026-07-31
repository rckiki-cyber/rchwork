import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Loader2, Plus, RefreshCw } from 'lucide-react'
import { InlineNoticeView } from './settings-controls'

type Translate = (key: string, options?: Record<string, unknown>) => string

const FETCH_DEBOUNCE_MS = 800
const MENU_GAP = 8
const MENU_MARGIN = 12
const MENU_MIN_HEIGHT = 220
const MENU_MAX_HEIGHT = 372

export type ModelListMenuPlacement = {
  left: number
  top: number
  width: number
  maxHeight: number
}

export function calculateModelListMenuPlacement({
  anchorRect,
  estimatedHeight,
  viewportHeight,
  viewportWidth,
  coordinateScale = 1
}: {
  anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top' | 'width'>
  estimatedHeight: number
  viewportHeight: number
  viewportWidth: number
  coordinateScale?: number
}): ModelListMenuPlacement {
  const scale = Number.isFinite(coordinateScale) && coordinateScale > 0 ? coordinateScale : 1
  const anchor = {
    bottom: anchorRect.bottom / scale,
    left: anchorRect.left / scale,
    right: anchorRect.right / scale,
    top: anchorRect.top / scale,
    width: anchorRect.width / scale
  }
  const normalizedViewportHeight = viewportHeight / scale
  const normalizedViewportWidth = viewportWidth / scale
  const width = Math.min(anchor.width, Math.max(0, normalizedViewportWidth - MENU_MARGIN * 2))
  const left = Math.min(
    Math.max(anchor.left, MENU_MARGIN),
    Math.max(MENU_MARGIN, normalizedViewportWidth - MENU_MARGIN - width)
  )
  const spaceBelow = Math.max(
    0,
    normalizedViewportHeight - anchor.bottom - MENU_GAP - MENU_MARGIN
  )
  const spaceAbove = Math.max(0, anchor.top - MENU_GAP - MENU_MARGIN)
  const targetHeight = Math.min(
    MENU_MAX_HEIGHT,
    Math.max(MENU_MIN_HEIGHT, estimatedHeight)
  )
  const openAbove = spaceBelow < targetHeight && spaceAbove > spaceBelow
  const availableHeight = openAbove ? spaceAbove : spaceBelow
  const maxHeight = Math.min(
    targetHeight,
    Math.max(Math.min(MENU_MIN_HEIGHT, availableHeight), availableHeight)
  )
  const top = openAbove
    ? Math.max(MENU_MARGIN, anchor.top - MENU_GAP - maxHeight)
    : anchor.bottom + MENU_GAP

  return { left, top, width, maxHeight }
}

function currentBodyZoom(): number {
  if (typeof window === 'undefined') return 1
  const zoom = window.getComputedStyle(document.body).zoom
  const parsed = Number.parseFloat(zoom)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

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
  const [menuPlacement, setMenuPlacement] = useState<ModelListMenuPlacement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
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
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
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

  useEffect(() => {
    if (!open) {
      setMenuPlacement(null)
      return
    }

    const updatePlacement = (): void => {
      const root = rootRef.current
      if (!root) return
      const estimatedHeight = 128 + Math.min(Math.max(visibleIds.length, 1) * 36, 240)
      setMenuPlacement(calculateModelListMenuPlacement({
        anchorRect: root.getBoundingClientRect(),
        estimatedHeight,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        coordinateScale: currentBodyZoom()
      }))
    }

    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [open, visibleIds.length])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

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
      <div data-control-hover-root className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-haspopup="menu"
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

      {open && menuPlacement && typeof document !== 'undefined' ? createPortal((
        <div
          ref={menuRef}
          role="menu"
          data-control-hover-root
          data-control-hover-layered
          data-control-hover-portal
          className="ds-no-drag fixed z-50 flex flex-col overflow-hidden rounded-[16px] border border-ds-border bg-ds-elevated shadow-[0_18px_52px_rgba(15,23,42,0.18)] backdrop-blur-xl dark:shadow-[0_22px_58px_rgba(0,0,0,0.38)]"
          style={{
            left: `${menuPlacement.left}px`,
            top: `${menuPlacement.top}px`,
            width: `${menuPlacement.width}px`,
            maxHeight: `${menuPlacement.maxHeight}px`
          } satisfies CSSProperties}
        >
          <div className="border-b border-ds-border p-2">
            <input
              autoFocus
              className="w-full rounded-[12px] border border-ds-border bg-ds-main/60 px-2.5 py-1.5 text-[13px] text-ds-ink focus:border-accent/40 focus:outline-none"
              placeholder={t('modelListFilterPlaceholder')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
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
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    data-control-active={checked ? 'true' : undefined}
                    onClick={() => toggleModel(id)}
                    className="flex w-full items-center gap-2 rounded-[12px] px-2 py-1.5 text-left text-[13px] text-ds-ink transition hover:bg-ds-hover"
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
              className="w-full rounded-[12px] border border-ds-border bg-ds-main/60 px-2.5 py-1.5 font-mono text-[12.5px] text-ds-ink focus:border-accent/40 focus:outline-none"
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
              className="shrink-0 rounded-[12px] border border-ds-border bg-ds-card p-1.5 text-ds-ink transition hover:bg-ds-hover disabled:opacity-50"
              title={t('modelListAdd')}
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
      ), document.body) : null}
    </div>
  )
}
