import { useEffect, type ReactElement, type ReactNode } from 'react'
import {
  Activity,
  BrainCircuit,
  Check,
  Circle,
  Clock3,
  Database,
  FileCheck2,
  History,
  LoaderCircle,
  MemoryStick,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LearningIterationCounts, LearningIterationStatus } from '@shared/ds-gui-api'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import { SidebarTitlebarToggleButton } from '../sidebar/SidebarPrimitives'
import { useLearningIterationStore } from '../../learning-iteration/learning-iteration-store'

const STAGES = [
  'learningStageCollect',
  'learningStageUnderstand',
  'learningStageExtract',
  'learningStageValidate',
  'learningStageConstruct',
  'learningStageTest',
  'learningStagePublish'
] as const

function formatDate(value: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function statusTone(status: LearningIterationStatus): string {
  if (status === 'failed') return 'border-red-500/25 bg-red-500/8 text-red-600 dark:text-red-300'
  if (status === 'running') return 'border-blue-500/25 bg-blue-500/8 text-blue-600 dark:text-blue-300'
  if (status === 'waiting') return 'border-amber-500/25 bg-amber-500/8 text-amber-600 dark:text-amber-300'
  if (status === 'disabled') return 'border-ds-border bg-ds-subtle text-ds-faint'
  return 'border-emerald-500/25 bg-emerald-500/8 text-emerald-600 dark:text-emerald-300'
}

function MetricCard({
  icon,
  label,
  value,
  detail
}: {
  icon: ReactNode
  label: string
  value: string | number
  detail?: string
}): ReactElement {
  return (
    <div className="rounded-[14px] border border-ds-border bg-ds-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-[12px] text-ds-muted">
        <span className="text-accent">{icon}</span>
        {label}
      </div>
      <div className="mt-3 text-[23px] font-semibold tracking-tight text-ds-ink">{value}</div>
      {detail ? <div className="mt-1 text-[11.5px] text-ds-faint">{detail}</div> : null}
    </div>
  )
}

function CountSummary({ counts }: { counts: LearningIterationCounts }): ReactElement {
  const { t } = useTranslation('common')
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard icon={<Database className="h-4 w-4" />} label={t('learningSources')} value={counts.sources} />
      <MetricCard
        icon={<MemoryStick className="h-4 w-4" />}
        label={t('learningMemoryChanges')}
        value={counts.memoriesCreated + counts.memoriesUpdated + counts.memoriesDisabled}
        detail={`+${counts.memoriesCreated} · ↻${counts.memoriesUpdated} · −${counts.memoriesDisabled}`}
      />
      <MetricCard
        icon={<Sparkles className="h-4 w-4" />}
        label={t('learningSkillChanges')}
        value={counts.skillsCreated + counts.skillsUpdated}
        detail={`+${counts.skillsCreated} · ↻${counts.skillsUpdated}`}
      />
      <MetricCard icon={<ShieldCheck className="h-4 w-4" />} label={t('learningRejected')} value={counts.rejected} />
    </div>
  )
}

export function LearningIterationView({
  leftSidebarCollapsed,
  onToggleLeftSidebar
}: {
  leftSidebarCollapsed: boolean
  onToggleLeftSidebar: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const status = useLearningIterationStore((state) => state.status)
  const records = useLearningIterationStore((state) => state.records)
  const selectedId = useLearningIterationStore((state) => state.selectedId)
  const detail = useLearningIterationStore((state) => state.detail)
  const loading = useLearningIterationStore((state) => state.loading)
  const actionPending = useLearningIterationStore((state) => state.actionPending)
  const notice = useLearningIterationStore((state) => state.notice)
  const refresh = useLearningIterationStore((state) => state.refresh)
  const queue = useLearningIterationStore((state) => state.queue)
  const cancel = useLearningIterationStore((state) => state.cancel)
  const rollback = useLearningIterationStore((state) => state.rollback)

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const current = detail?.summary ?? records.find((record) => record.id === selectedId) ?? null

  return (
    <div className="ds-no-drag flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex min-h-[66px] shrink-0 items-center border-b border-ds-border-muted px-6">
        {leftSidebarCollapsed ? (
          <SidebarTitlebarToggleButton
            onClick={onToggleLeftSidebar}
            title={t('sidebarExpand')}
            ariaLabel={t('sidebarExpand')}
            className="mr-3"
          />
        ) : null}
        <div className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-accent/10 text-accent">
          <BrainCircuit className="h-5 w-5" strokeWidth={1.7} />
        </div>
        <div className="ml-3 min-w-0">
          <h1 className="truncate text-[16px] font-semibold text-ds-ink">
            {selectedId ? current?.displayName ?? t('learningIteration') : t('learningIterationOverview')}
          </h1>
          <p className="mt-0.5 truncate text-[11.5px] text-ds-faint">
            {selectedId ? t('learningIterationRecordSubtitle') : t('learningIterationSubtitle')}
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {selectedId ? (
          <div className="mx-auto w-full max-w-[980px] px-6 py-7">
            {current ? (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className={`rounded-full border px-3 py-1 text-[11.5px] font-semibold ${statusTone(current.status)}`}>
                  {t(`learningStatus_${current.status}`)}
                </div>
                {current.canRollback ? (
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={() => void rollback(current.id)}
                    className="inline-flex h-8 items-center gap-2 rounded-[8px] border border-ds-border bg-ds-card px-3 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t('learningRollback')}
                  </button>
                ) : null}
              </div>
            ) : null}
            {loading && !detail ? (
              <div className="flex min-h-[240px] items-center justify-center text-ds-faint">
                <LoaderCircle className="h-5 w-5 animate-spin" />
              </div>
            ) : detail ? (
              <>
                <CountSummary counts={detail.summary.counts} />
                <article className="mt-5 rounded-[16px] border border-ds-border bg-ds-card px-6 py-5 shadow-sm">
                  <AssistantMarkdown
                    text={detail.reportMarkdown}
                    streaming={false}
                    className="min-w-0 text-[13.5px] leading-7 text-ds-ink"
                  />
                </article>
              </>
            ) : (
              <div className="rounded-[14px] border border-ds-border bg-ds-card p-6 text-[13px] text-ds-muted">
                {notice || t('learningIterationLoadFailed')}
              </div>
            )}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[1080px] px-6 py-7">
            <section className="rounded-[16px] border border-ds-border bg-ds-card p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-accent" />
                    <h2 className="text-[14px] font-semibold text-ds-ink">{t('learningCurrentStatus')}</h2>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <span className={`rounded-full border px-3 py-1 text-[11.5px] font-semibold ${statusTone(status?.status ?? 'idle')}`}>
                      {t(`learningStatus_${status?.status ?? 'idle'}`)}
                    </span>
                    <span className="text-[12.5px] text-ds-muted">{status?.message ?? t('learningIterationLoading')}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  {status?.running || status?.queued ? (
                    <button
                      type="button"
                      disabled={actionPending}
                      onClick={() => void cancel()}
                      className="inline-flex h-9 items-center gap-2 rounded-[9px] border border-ds-border bg-ds-card px-3.5 text-[12.5px] font-semibold text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50"
                    >
                      <X className="h-4 w-4" />
                      {t('learningCancel')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={!status?.enabled || actionPending || status?.running || status?.queued}
                    onClick={() => void queue()}
                    className="inline-flex h-9 items-center gap-2 rounded-[9px] bg-accent px-3.5 text-[12.5px] font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {actionPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {t('learningCheckNow')}
                  </button>
                </div>
              </div>
              {notice ? (
                <div className="mt-4 rounded-[9px] border border-ds-border-muted bg-ds-subtle px-3 py-2 text-[12px] text-ds-muted">
                  {notice}
                </div>
              ) : null}
            </section>

            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricCard
                icon={<Clock3 className="h-4 w-4" />}
                label={t('learningLastSuccess')}
                value={status?.lastSuccessfulAt ? formatDate(status.lastSuccessfulAt) : '—'}
              />
              <MetricCard
                icon={<FileCheck2 className="h-4 w-4" />}
                label={t('learningTodayEligibility')}
                value={!status?.enabled
                  ? t('learningDisabledShort')
                  : status.running || status.queued
                    ? t('learningQueuedShort')
                    : status.eligibleToday
                      ? t('learningEligibleShort')
                      : t('learningUsedTodayShort')}
              />
              <MetricCard
                icon={<History className="h-4 w-4" />}
                label={t('learningBaselineProgress')}
                value={`${Math.round((status?.baselineProgress ?? 0) * 100)}%`}
                detail={status?.baselineComplete ? t('learningBaselineComplete') : t('learningBaselineContinuing')}
              />
              <MetricCard
                icon={<Database className="h-4 w-4" />}
                label={t('learningNextBatch')}
                value={status?.pendingSourceCount ?? 0}
                detail={t('learningNextBatchUnit')}
              />
            </div>

            {status?.latest ? (
              <div className="mt-4">
                <CountSummary counts={status.latest.counts} />
              </div>
            ) : null}

            <section className="mt-4 rounded-[16px] border border-ds-border bg-ds-card p-5 shadow-sm">
              <h2 className="text-[14px] font-semibold text-ds-ink">{t('learningPipeline')}</h2>
              <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-7">
                {STAGES.map((stage, index) => {
                  const completed = status?.latest?.status === 'completed' || status?.latest?.status === 'rolled_back'
                  const runningIndex = status?.running ? 2 : -1
                  return (
                    <div key={stage} className="relative rounded-[10px] border border-ds-border-muted bg-ds-subtle px-3 py-3">
                      <div className="flex items-center gap-2">
                        {completed || index < runningIndex ? (
                          <Check className="h-3.5 w-3.5 text-emerald-500" />
                        ) : index === runningIndex ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-blue-500" />
                        ) : (
                          <Circle className="h-3 w-3 text-ds-faint" />
                        )}
                        <span className="text-[11.5px] font-medium text-ds-muted">{t(stage)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="mt-4 rounded-[16px] border border-ds-border bg-ds-card p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[14px] font-semibold text-ds-ink">{t('learningLatestSummary')}</h2>
                {status?.latest?.canRollback ? (
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={() => void rollback(status.latest!.id)}
                    className="inline-flex h-8 items-center gap-2 rounded-[8px] border border-ds-border bg-ds-card px-3 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t('learningRollbackLatest')}
                  </button>
                ) : null}
              </div>
              <p className="mt-3 text-[13px] leading-6 text-ds-muted">
                {status?.latest
                  ? `${status.latest.displayName} · ${formatDate(status.latest.finishedAt)}`
                  : t('learningNoSummary')}
              </p>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
