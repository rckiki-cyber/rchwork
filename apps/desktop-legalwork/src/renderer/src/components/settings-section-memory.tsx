import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Ban,
  Database,
  Edit3,
  Loader2,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2
} from 'lucide-react'
import type { CoreMemoryRecordJson } from '../agent/legalwork-contract'
import { getProvider } from '../agent/registry'
import { AstryxButton } from './astryx/AstryxButton'
import { AstryxDialog } from './astryx/AstryxDialog'
import { AstryxInput } from './astryx/AstryxInput'
import { AstryxSelect } from './astryx/AstryxSelect'
import { AstryxTextarea } from './astryx/AstryxTextarea'
import { InlineNoticeView, SettingsCard } from './settings-controls'

type MemoryTab = 'active' | 'disabled' | 'deleted'
type MemoryDraft = {
  id?: string
  content: string
  scope: CoreMemoryRecordJson['scope']
  category: CoreMemoryRecordJson['category']
  recallPolicy: CoreMemoryRecordJson['recallPolicy']
  tags: string
  confidence: string
}

const EMPTY_DRAFT: MemoryDraft = {
  content: '',
  scope: 'workspace',
  category: 'preference',
  recallPolicy: 'always',
  tags: '',
  confidence: '1'
}

const MEMORY_CATEGORIES: CoreMemoryRecordJson['category'][] = [
  'profile',
  'preference',
  'workflow',
  'project',
  'interest',
  'matter',
  'other'
]

const MEMORY_SCOPES: CoreMemoryRecordJson['scope'][] = ['user', 'workspace', 'project']

export function MemorySettingsSection({ workspace }: { workspace: string }): ReactElement {
  const { t, i18n } = useTranslation('settings')
  const [records, setRecords] = useState<CoreMemoryRecordJson[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null)
  const [tab, setTab] = useState<MemoryTab>('active')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | CoreMemoryRecordJson['scope']>('all')
  const [category, setCategory] = useState<'all' | CoreMemoryRecordJson['category']>('all')
  const [draft, setDraft] = useState<MemoryDraft | null>(null)
  const [purgeTarget, setPurgeTarget] = useState<CoreMemoryRecordJson | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const provider = getProvider()
    if (!provider.listMemories) {
      setNotice({ tone: 'error', message: t('memoryUnavailable') })
      return
    }
    setLoading(true)
    setNotice(null)
    try {
      setRecords(await provider.listMemories({ workspace: workspace || undefined, includeDeleted: true }))
    } catch (error) {
      setNotice({ tone: 'error', message: readableError(error, t('memoryLoadFailed')) })
    } finally {
      setLoading(false)
    }
  }, [t, workspace])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const counts = useMemo(() => ({
    active: records.filter((record) => !record.deletedAt && !record.disabledAt).length,
    disabled: records.filter((record) => !record.deletedAt && Boolean(record.disabledAt)).length,
    deleted: records.filter((record) => Boolean(record.deletedAt)).length
  }), [records])

  const visibleRecords = useMemo(() => {
    return filterMemoryRecords(records, { tab, query, scope, category })
  }, [category, query, records, scope, tab])

  const mutate = async (
    memoryId: string,
    action: () => Promise<unknown>,
    successMessage: string
  ): Promise<void> => {
    setBusyId(memoryId)
    setNotice(null)
    try {
      await action()
      await refresh()
      setNotice({ tone: 'success', message: successMessage })
    } catch (error) {
      setNotice({ tone: 'error', message: readableError(error, t('memorySaveFailed')) })
    } finally {
      setBusyId(null)
    }
  }

  const saveDraft = async (): Promise<void> => {
    if (!draft?.content.trim()) {
      setNotice({ tone: 'error', message: t('memoryContentRequired') })
      return
    }
    const provider = getProvider()
    const confidence = Number(draft.confidence)
    const tags = draft.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean)
    const context = draft.scope === 'user'
      ? {}
      : {
          workspace: workspace || undefined,
          project: draft.scope === 'project' ? workspace || undefined : undefined
        }
    setBusyId(draft.id ?? 'new')
    setNotice(null)
    try {
      if (draft.id) {
        if (!provider.updateMemory) throw new Error(t('memoryUnavailable'))
        await provider.updateMemory(draft.id, {
          content: draft.content.trim(),
          scope: draft.scope,
          category: draft.category,
          recallPolicy: draft.recallPolicy,
          tags,
          confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 1,
          ...context
        })
      } else {
        if (!provider.createMemory) throw new Error(t('memoryUnavailable'))
        await provider.createMemory({
          content: draft.content.trim(),
          scope: draft.scope,
          category: draft.category,
          recallPolicy: draft.recallPolicy,
          tags,
          confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 1,
          ...context
        })
      }
      setDraft(null)
      await refresh()
      setNotice({ tone: 'success', message: t(draft.id ? 'memoryUpdated' : 'memoryCreated') })
    } catch (error) {
      setNotice({ tone: 'error', message: readableError(error, t('memorySaveFailed')) })
    } finally {
      setBusyId(null)
    }
  }

  const editRecord = (record: CoreMemoryRecordJson): void => {
    setDraft({
      id: record.id,
      content: record.content,
      scope: record.scope,
      category: record.category,
      recallPolicy: record.recallPolicy,
      tags: (record.tags ?? []).join(', '),
      confidence: String(record.confidence ?? 1)
    })
  }

  return (
    <div className="space-y-6">
      <SettingsCard title={t('memoryCenter')}>
        <div className="grid gap-3 px-3 py-4 sm:grid-cols-3">
          {(['active', 'disabled', 'deleted'] as const).map((state) => (
            <button
              key={state}
              type="button"
              onClick={() => setTab(state)}
              className={`min-h-20 rounded-xl border px-4 py-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 ${
                tab === state
                  ? 'border-accent/35 bg-accent/10'
                  : 'border-ds-border-muted bg-ds-main/40 hover:bg-ds-hover'
              }`}
            >
              <div className="text-[12px] font-medium text-ds-muted">{t(`memoryState_${state}`)}</div>
              <div className="mt-1 text-[24px] font-semibold text-ds-ink">{counts[state]}</div>
            </button>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title={t('memoryManage')}>
        <div className="space-y-3 px-3 py-4">
          <div className="flex flex-col gap-2 lg:flex-row">
            <AstryxInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('memorySearchPlaceholder')}
              icon={<Search className="h-4 w-4" strokeWidth={1.75} />}
              clearable
              onClear={() => setQuery('')}
              className="min-w-0 flex-1"
            />
            <AstryxSelect
              value={scope}
              onChange={(event) => setScope(event.target.value as typeof scope)}
              aria-label={t('memoryScope')}
              className="w-full lg:w-40"
              options={[
                { value: 'all', label: t('memoryAllScopes') },
                ...MEMORY_SCOPES.map((value) => ({ value, label: t(`memoryScope_${value}`) }))
              ]}
            />
            <AstryxSelect
              value={category}
              onChange={(event) => setCategory(event.target.value as typeof category)}
              aria-label={t('memoryCategory')}
              className="w-full lg:w-44"
              options={[
                { value: 'all', label: t('memoryAllCategories') },
                ...MEMORY_CATEGORIES.map((value) => ({ value, label: t(`memoryCategory_${value}`) }))
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12.5px] text-ds-muted">
              {t('memoryVisibleCount', { count: visibleRecords.length })}
            </p>
            <div className="flex items-center gap-2">
              <AstryxButton variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.75} />
                {t('memoryRefresh')}
              </AstryxButton>
              <AstryxButton
                size="sm"
                onClick={() => setDraft({
                  ...EMPTY_DRAFT,
                  scope: workspace ? 'workspace' : 'user'
                })}
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
                {t('memoryCreate')}
              </AstryxButton>
            </div>
          </div>
          {notice ? <InlineNoticeView notice={notice} /> : null}
        </div>

        <div className="space-y-2 px-3 py-4">
          {loading && records.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-ds-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('memoryLoading')}
            </div>
          ) : visibleRecords.length === 0 ? (
            <div className="rounded-xl border border-dashed border-ds-border px-4 py-10 text-center">
              <Database className="mx-auto h-6 w-6 text-ds-faint" strokeWidth={1.5} />
              <p className="mt-2 text-[13px] text-ds-muted">{t('memoryNoResults')}</p>
            </div>
          ) : visibleRecords.map((record) => (
            <article
              key={record.id}
              className="rounded-xl border border-ds-border-muted bg-ds-main/40 px-4 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words text-[13.5px] leading-6 text-ds-ink">
                    {record.content}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ds-faint">
                    <MemoryBadge>{t(`memoryCategory_${record.category}`)}</MemoryBadge>
                    <MemoryBadge>{t(`memoryScope_${record.scope}`)}</MemoryBadge>
                    <MemoryBadge>
                      {record.recallPolicy === 'always' ? t('memoryRecallAlways') : t('memoryRecallRelevant')}
                    </MemoryBadge>
                    <span>{t(`memorySource_${record.captureSource}`)}</span>
                    <span>{Math.round((record.confidence ?? 1) * 100)}%</span>
                    <span>{new Date(record.updatedAt).toLocaleString(i18n.language)}</span>
                    {record.sourceThreadId ? <span className="font-mono">{record.sourceThreadId}</span> : null}
                  </div>
                  {record.tags?.length ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {record.tags.map((tag) => (
                        <span key={tag} className="rounded-full bg-ds-subtle px-2 py-0.5 text-[10.5px] text-ds-muted">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                  {tab === 'deleted' ? (
                    <>
                      <AstryxButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title={t('memoryRestore')}
                        aria-label={t('memoryRestore')}
                        disabled={busyId === record.id}
                        onClick={() => void mutate(
                          record.id,
                          async () => {
                            const provider = getProvider()
                            if (!provider.updateMemory) throw new Error(t('memoryUnavailable'))
                            await provider.updateMemory(record.id, { restore: true, disabled: false })
                          },
                          t('memoryRestored')
                        )}
                      >
                        <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
                      </AstryxButton>
                      <AstryxButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-600"
                        title={t('memoryDeletePermanent')}
                        aria-label={t('memoryDeletePermanent')}
                        onClick={() => setPurgeTarget(record)}
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                      </AstryxButton>
                    </>
                  ) : (
                    <>
                      <AstryxButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title={t('memoryEdit')}
                        aria-label={t('memoryEdit')}
                        onClick={() => editRecord(record)}
                      >
                        <Edit3 className="h-4 w-4" strokeWidth={1.75} />
                      </AstryxButton>
                      <AstryxButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title={record.disabledAt ? t('memoryEnable') : t('memoryDisable')}
                        aria-label={record.disabledAt ? t('memoryEnable') : t('memoryDisable')}
                        disabled={busyId === record.id}
                        onClick={() => void mutate(
                          record.id,
                          async () => {
                            const provider = getProvider()
                            if (!provider.updateMemory) throw new Error(t('memoryUnavailable'))
                            await provider.updateMemory(record.id, { disabled: !record.disabledAt })
                          },
                          t(record.disabledAt ? 'memoryEnabled' : 'memoryDisabled')
                        )}
                      >
                        {record.disabledAt
                          ? <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
                          : <Ban className="h-4 w-4" strokeWidth={1.75} />}
                      </AstryxButton>
                      <AstryxButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title={record.recallPolicy === 'always' ? t('memoryRecallRelevant') : t('memoryRecallAlways')}
                        aria-label={record.recallPolicy === 'always' ? t('memoryRecallRelevant') : t('memoryRecallAlways')}
                        disabled={busyId === record.id}
                        onClick={() => void mutate(
                          record.id,
                          async () => {
                            const provider = getProvider()
                            if (!provider.updateMemory) throw new Error(t('memoryUnavailable'))
                            await provider.updateMemory(record.id, {
                              recallPolicy: record.recallPolicy === 'always' ? 'relevant' : 'always'
                            })
                          },
                          t('memoryUpdated')
                        )}
                      >
                        <Pin className="h-4 w-4" strokeWidth={1.75} />
                      </AstryxButton>
                      <AstryxButton
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-600"
                        title={t('memoryMoveToTrash')}
                        aria-label={t('memoryMoveToTrash')}
                        disabled={busyId === record.id}
                        onClick={() => void mutate(
                          record.id,
                          async () => {
                            const provider = getProvider()
                            if (!provider.deleteMemory) throw new Error(t('memoryUnavailable'))
                            await provider.deleteMemory(record.id)
                          },
                          t('memoryMovedToTrash')
                        )}
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                      </AstryxButton>
                    </>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </SettingsCard>

      <AstryxDialog
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title={t(draft?.id ? 'memoryEditTitle' : 'memoryCreateTitle')}
        description={t('memoryFormDesc')}
        footer={
          <>
            <AstryxButton variant="ghost" onClick={() => setDraft(null)}>{t('cancel')}</AstryxButton>
            <AstryxButton onClick={() => void saveDraft()} disabled={busyId !== null}>
              {busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('save')}
            </AstryxButton>
          </>
        }
      >
        {draft ? (
          <div className="grid gap-4">
            <AstryxTextarea
              label={t('memoryContent')}
              value={draft.content}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              required
              maxLength={10_000}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <AstryxSelect
                label={t('memoryCategory')}
                value={draft.category}
                onChange={(event) => setDraft({
                  ...draft,
                  category: event.target.value as MemoryDraft['category']
                })}
                options={MEMORY_CATEGORIES.map((value) => ({
                  value,
                  label: t(`memoryCategory_${value}`)
                }))}
              />
              <AstryxSelect
                label={t('memoryScope')}
                value={draft.scope}
                onChange={(event) => setDraft({
                  ...draft,
                  scope: event.target.value as MemoryDraft['scope']
                })}
                options={MEMORY_SCOPES.map((value) => ({
                  value,
                  label: t(`memoryScope_${value}`),
                  disabled: value !== 'user' && !workspace
                }))}
              />
              <AstryxSelect
                label={t('memoryRecallPolicy')}
                value={draft.recallPolicy}
                onChange={(event) => setDraft({
                  ...draft,
                  recallPolicy: event.target.value as MemoryDraft['recallPolicy']
                })}
                options={[
                  { value: 'always', label: t('memoryRecallAlways') },
                  { value: 'relevant', label: t('memoryRecallRelevant') }
                ]}
              />
              <AstryxInput
                label={t('memoryConfidence')}
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={draft.confidence}
                onChange={(event) => setDraft({ ...draft, confidence: event.target.value })}
              />
            </div>
            <AstryxInput
              label={t('memoryTags')}
              value={draft.tags}
              onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
              placeholder={t('memoryTagsPlaceholder')}
            />
            <p className="text-[12px] leading-5 text-ds-muted">{t('memorySecretWarning')}</p>
          </div>
        ) : null}
      </AstryxDialog>

      <AstryxDialog
        open={Boolean(purgeTarget)}
        onClose={() => setPurgeTarget(null)}
        title={t('memoryDeletePermanentTitle')}
        description={t('memoryDeletePermanentDesc')}
        className="max-w-[520px]"
        footer={
          <>
            <AstryxButton variant="ghost" onClick={() => setPurgeTarget(null)}>{t('cancel')}</AstryxButton>
            <AstryxButton
              variant="danger"
              disabled={busyId !== null}
              onClick={() => {
                if (!purgeTarget) return
                const target = purgeTarget
                setPurgeTarget(null)
                void mutate(
                  target.id,
                  async () => {
                    const provider = getProvider()
                    if (!provider.purgeMemory) throw new Error(t('memoryUnavailable'))
                    await provider.purgeMemory(target.id)
                  },
                  t('memoryDeletedPermanent')
                )
              }}
            >
              {t('memoryDeletePermanent')}
            </AstryxButton>
          </>
        }
      >
        <p className="whitespace-pre-wrap break-words rounded-xl border border-ds-border-muted bg-ds-main/50 px-3 py-2 text-[13px] leading-5 text-ds-ink">
          {purgeTarget?.content}
        </p>
      </AstryxDialog>
    </div>
  )
}

function MemoryBadge({ children }: { children: string }): ReactElement {
  return (
    <span className="inline-flex items-center rounded-full border border-ds-border-muted bg-ds-card px-2 py-0.5 font-medium text-ds-muted">
      {children}
    </span>
  )
}

export function memoryTab(record: CoreMemoryRecordJson): MemoryTab {
  if (record.deletedAt) return 'deleted'
  if (record.disabledAt) return 'disabled'
  return 'active'
}

export function filterMemoryRecords(
  records: CoreMemoryRecordJson[],
  filters: {
    tab: MemoryTab
    query: string
    scope: 'all' | CoreMemoryRecordJson['scope']
    category: 'all' | CoreMemoryRecordJson['category']
  }
): CoreMemoryRecordJson[] {
  const normalizedQuery = filters.query.normalize('NFKC').toLocaleLowerCase().trim()
  return records.filter((record) => {
    if (memoryTab(record) !== filters.tab) return false
    if (filters.scope !== 'all' && record.scope !== filters.scope) return false
    if (filters.category !== 'all' && record.category !== filters.category) return false
    if (!normalizedQuery) return true
    return `${record.content} ${(record.tags ?? []).join(' ')}`
      .normalize('NFKC')
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  })
}

function readableError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}
