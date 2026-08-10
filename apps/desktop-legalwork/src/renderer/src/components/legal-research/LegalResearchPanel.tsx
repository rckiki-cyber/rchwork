import type { ReactElement } from 'react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  FileDown,
  FilePenLine,
  FileText,
  MessageSquareText,
  Scale,
  Search,
  Square
} from 'lucide-react'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import { ThinkingOrbStatus } from '../chat/ThinkingOrbStatus'
import { orbStateForResearchLive, orbStateForResearchPhase, orbStateForResearchText } from './legal-research-orb'
import type { ReturnUseLegalResearch } from './useLegalResearch'
import {
  preprocessLegalResearchSummary,
  resolveLegalResearchMarkdown
} from './legal-research-markdown'
import { shouldStartLegalResearchFromKeyboard } from './legal-research-keyboard'
import { extractResearchPlanItems, extractStageNumber, formatResearchPlanIndex } from './legal-research-plan'
import { LegalResearchEditorDialog } from './LegalResearchEditorDialog'

const StableAssistantMarkdown = memo(AssistantMarkdown)

export type LegalResearchPanelProps = {
  legalResearch: ReturnUseLegalResearch
}

export function scrollLegalResearchToLatest(element: HTMLDivElement | null): void {
  if (!element) return
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
}

export function nextSmoothResearchScrollTop(
  current: number,
  target: number,
  elapsedMs = 1000 / 60
): number {
  const distance = target - current
  if (Math.abs(distance) <= 0.75) return target
  const boundedElapsed = Math.max(1, Math.min(elapsedMs, 50))
  const interpolation = 1 - Math.exp(-boundedElapsed / 90)
  return current + distance * interpolation
}

export function shouldFollowLatestResearchContent(
  element: Pick<HTMLDivElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>,
  threshold = 12
): boolean {
  const distanceFromLatest = element.scrollHeight - element.scrollTop - element.clientHeight
  return distanceFromLatest <= threshold
}

export function LegalResearchPanel({ legalResearch }: LegalResearchPanelProps): ReactElement {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  const smoothScrollFrameRef = useRef<number | null>(null)
  const smoothScrollTargetRef = useRef(0)
  const lastSmoothScrollFrameRef = useRef<number | null>(null)
  const autoScrollingRef = useRef(false)
  const scrollbarPointerRef = useRef(false)
  const [clockNow, setClockNow] = useState(Date.now())
  const [exportFormat, setExportFormat] = useState<'word' | 'markdown' | null>(null)
  const [exportNotice, setExportNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null)
  // 北大法宝 + 元典 都未配置 token 时提示用户去插件市场配置（不阻断调研启动）。
  const [legalSourcesMissingToken, setLegalSourcesMissingToken] = useState(false)
  const {
    activeRecord,
    isResearching,
    runResearch,
    stopResearch,
    saveEditedSummary
  } = legalResearch

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 读取 MCP 配置，检测北大法宝与元典是否都未配置访问 Token。
  // 若都未配置，显示引导提示（不影响调研启动）。
  useEffect(() => {
    let cancelled = false
    async function checkLegalSourceTokens(): Promise<void> {
      try {
        if (typeof window.dsGui?.getDeepseekConfigFile !== 'function') return
        const file = await window.dsGui.getDeepseekConfigFile()
        if (cancelled || !file?.content) return
        setLegalSourcesMissingToken(!hasAnyLegalSourceToken(file.content))
      } catch {
        // 读取配置失败时保持不提示，调研不受影响。
      }
    }
    void checkLegalSourceTokens()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isResearching || activeRecord?.status !== 'running') return
    setClockNow(Date.now())
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activeRecord?.id, activeRecord?.status, isResearching])

  useEffect(() => {
    setEditingRecordId(null)
  }, [activeRecord?.id])

  const cancelSmoothFollow = useCallback(() => {
    if (smoothScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(smoothScrollFrameRef.current)
      smoothScrollFrameRef.current = null
    }
    lastSmoothScrollFrameRef.current = null
    autoScrollingRef.current = false
  }, [])

  const refreshSmoothFollowTarget = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    smoothScrollTargetRef.current = Math.max(0, element.scrollHeight - element.clientHeight)
  }, [])

  const startSmoothFollow = useCallback(() => {
    refreshSmoothFollowTarget()
    if (smoothScrollFrameRef.current !== null || !followLatestRef.current) return
    const element = scrollRef.current
    if (!element) return

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      scrollLegalResearchToLatest(element)
      refreshSmoothFollowTarget()
      return
    }

    autoScrollingRef.current = true
    const step = (timestamp: number): void => {
      const currentElement = scrollRef.current
      if (!currentElement || !followLatestRef.current) {
        smoothScrollFrameRef.current = null
        lastSmoothScrollFrameRef.current = null
        autoScrollingRef.current = false
        return
      }

      const previousTimestamp = lastSmoothScrollFrameRef.current ?? timestamp - 1000 / 60
      lastSmoothScrollFrameRef.current = timestamp
      const target = smoothScrollTargetRef.current
      const next = nextSmoothResearchScrollTop(
        currentElement.scrollTop,
        target,
        timestamp - previousTimestamp
      )
      currentElement.scrollTop = next

      if (next === target) {
        smoothScrollFrameRef.current = null
        lastSmoothScrollFrameRef.current = null
        autoScrollingRef.current = false
        return
      }
      smoothScrollFrameRef.current = window.requestAnimationFrame(step)
    }

    smoothScrollFrameRef.current = window.requestAnimationFrame(step)
  }, [refreshSmoothFollowTarget])

  useLayoutEffect(() => {
    cancelSmoothFollow()
    followLatestRef.current = true
    scrollLegalResearchToLatest(scrollRef.current)
    refreshSmoothFollowTarget()
  }, [activeRecord?.id, cancelSmoothFollow, refreshSmoothFollowTarget])

  useEffect(() => {
    const viewport = scrollRef.current
    const content = scrollContentRef.current
    if (!viewport || !content || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      refreshSmoothFollowTarget()
      if (followLatestRef.current) startSmoothFollow()
    })
    observer.observe(viewport)
    observer.observe(content)
    return () => observer.disconnect()
  }, [activeRecord?.id, refreshSmoothFollowTarget, startSmoothFollow])

  useEffect(() => cancelSmoothFollow, [cancelSmoothFollow])

  const handleResultsScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    if (autoScrollingRef.current && !scrollbarPointerRef.current) return
    if (scrollbarPointerRef.current) cancelSmoothFollow()
    const shouldFollow = shouldFollowLatestResearchContent(element)
    followLatestRef.current = shouldFollow
    if (shouldFollow) {
      refreshSmoothFollowTarget()
      startSmoothFollow()
    }
  }, [cancelSmoothFollow, refreshSmoothFollowTarget, startSmoothFollow])

  const handleResultsWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY >= 0) return
    cancelSmoothFollow()
    followLatestRef.current = false
  }, [cancelSmoothFollow])

  const handleResultsPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const element = scrollRef.current
    if (!element) return
    const scrollbarWidth = Math.max(0, element.offsetWidth - element.clientWidth)
    const scrollbarStart = element.getBoundingClientRect().right - scrollbarWidth - 4
    scrollbarPointerRef.current = event.pointerType === 'touch' || event.clientX >= scrollbarStart
  }, [])

  const handleResultsPointerEnd = useCallback(() => {
    scrollbarPointerRef.current = false
  }, [])

  const handleStart = useCallback(() => {
    if (!query.trim() || isResearching) return
    void runResearch(query.trim())
    setQuery('')
  }, [query, isResearching, runResearch])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!shouldStartLegalResearchFromKeyboard({
        key: e.key,
        isComposing: e.nativeEvent.isComposing,
        keyCode: e.keyCode
      }, composingRef.current)) return
      e.preventDefault()
      handleStart()
    },
    [handleStart]
  )

  const handleExportWord = useCallback(async () => {
    if (!activeRecord || (!activeRecord.summary && activeRecord.editedSummary === undefined)) return
    if (typeof window.dsGui?.exportLegalResearchToWord !== 'function') {
      setExportNotice({ tone: 'error', text: t('legalResearchExportWordUnsupported') })
      return
    }
    if (exportFormat) return
    setExportFormat('word')
    setExportNotice(null)

    const { query } = activeRecord
    const markdown = preprocessLegalResearchSummary(resolveLegalResearchMarkdown(activeRecord))
    const defaultName = `法律调研_${query.slice(0, 30)}`.replace(/[<>:"/\\|?*]/g, '_')
    try {
      const result = await window.dsGui.exportLegalResearchToWord({
        markdown,
        templateName: '法律调研报告',
        defaultName
      })
      if (result.ok) {
        setExportNotice({ tone: 'success', text: t('legalResearchExportSuccess', { path: result.path }) })
      } else if (!result.canceled) {
        setExportNotice({
          tone: 'error',
          text: t('legalResearchExportWordFailed', { message: result.message || '' })
        })
      }
    } catch (error) {
      setExportNotice({
        tone: 'error',
        text: t('legalResearchExportWordFailed', {
          message: error instanceof Error ? error.message : ''
        })
      })
    } finally {
      setExportFormat(null)
    }
  }, [activeRecord, exportFormat, t])

  const handleExportMarkdown = useCallback(async () => {
    if (!activeRecord || (!activeRecord.summary && activeRecord.editedSummary === undefined)) return
    if (typeof window.dsGui?.exportMarkdownDocument !== 'function') {
      setExportNotice({ tone: 'error', text: t('legalResearchExportMarkdownUnsupported') })
      return
    }
    if (exportFormat) return
    setExportFormat('markdown')
    setExportNotice(null)

    const { query } = activeRecord
    const markdown = preprocessLegalResearchSummary(resolveLegalResearchMarkdown(activeRecord))
    const defaultName = `法律调研_${query.slice(0, 30)}`.replace(/[<>:"/\\|?*]/g, '_')
    try {
      const result = await window.dsGui.exportMarkdownDocument({ markdown, defaultName })
      if (result.ok) {
        setExportNotice({ tone: 'success', text: t('legalResearchExportSuccess', { path: result.path }) })
      } else if (!result.canceled) {
        setExportNotice({
          tone: 'error',
          text: t('legalResearchExportMarkdownFailed', { message: result.message || '' })
        })
      }
    } catch (error) {
      setExportNotice({
        tone: 'error',
        text: t('legalResearchExportMarkdownFailed', {
          message: error instanceof Error ? error.message : ''
        })
      })
    } finally {
      setExportFormat(null)
    }
  }, [activeRecord, exportFormat, t])

  const handleSaveEditedReport = useCallback(
    (markdown: string) => {
      if (!activeRecord || editingRecordId !== activeRecord.id) return
      saveEditedSummary(activeRecord.id, markdown)
      setEditingRecordId(null)
      setExportNotice({ tone: 'success', text: t('legalResearchEditSaved') })
    },
    [activeRecord, editingRecordId, saveEditedSummary, t]
  )

  const formatDuration = (milliseconds: number): string => {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    if (minutes < 60) return `${minutes}m ${remainder}s`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m`
  }

  const updatedAt = activeRecord?.updatedAt ?? Date.now()
  const runningSince = activeRecord?.status === 'running' ? clockNow - updatedAt : 0
  const hasActiveReport = Boolean(
    activeRecord
      && activeRecord.status !== 'running'
      && (activeRecord.summary || activeRecord.editedSummary !== undefined)
  )
  const resolvedReport = useMemo(
    () => hasActiveReport && activeRecord
      ? preprocessLegalResearchSummary(resolveLegalResearchMarkdown(activeRecord))
      : '',
    [activeRecord, hasActiveReport]
  )
  const researchPlanItems = useMemo(
    () => (activeRecord?.reasoning || activeRecord?.planning)
      ? extractResearchPlanItems(activeRecord.planning || activeRecord.reasoning || '')
      : [],
    [activeRecord?.reasoning, activeRecord?.planning]
  )
  const researchUpdates = activeRecord?.updates ?? []
  const visibleResearchUpdates = activeRecord?.status === 'running'
    ? researchUpdates
    : researchUpdates.slice(0, -1)
  const showResearchPlan = activeRecord?.status === 'running' || Boolean(activeRecord?.reasoning)
  const isResearchPlanStreaming = activeRecord?.status === 'running' && visibleResearchUpdates.length === 0
  // 当前正在执行的关键工具（例如阻塞较久的 IMA 知识库检索），让用户在等待期
  // 知道 agent 在做什么，而不是只看到“等待下一条结果”的转圈。
  const currentTool = useMemo(() => {
    if (activeRecord?.status !== 'running') return ''
    const steps = activeRecord.steps ?? []
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]
      if (step.status !== 'done' && step.status !== 'error' && step.tool) return step.tool
    }
    return ''
  }, [activeRecord])

  return (
    <div className="legal-research-stage ds-subfeature-controls flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--ds-main)]">
      <header className="shrink-0 border-b border-[var(--ds-border)] px-6 py-5">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-[var(--ds-border)] bg-[var(--ds-accent-soft)] text-[var(--ds-accent)] shadow-sm">
              <Scale className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h2 className="text-[16px] font-semibold text-[var(--ds-ink)]">{t('legalResearch')}</h2>
              <p className="mt-0.5 text-[12px] text-[var(--ds-faint)]">{t('legalResearchSubtitle')}</p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-[16px] border border-[var(--ds-border)] bg-[var(--ds-card-soft)] p-1.5 shadow-sm">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-faint)]" strokeWidth={1.75} />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={() => {
                  composingRef.current = false
                }}
                onKeyDown={handleKeyDown}
                placeholder={t('legalResearchPlaceholder')}
                disabled={isResearching}
                className="h-10 w-full rounded-[12px] border border-transparent bg-transparent pl-9 pr-3 text-[14px] text-[var(--ds-ink)] outline-none transition focus:border-[var(--ds-border-strong)] focus:bg-[var(--ds-card-strong)] focus-visible:ring-1 focus-visible:ring-[var(--ds-accent)]/25 disabled:opacity-60"
              />
            </div>
            {isResearching ? (
              <button
                type="button"
                onClick={stopResearch}
                className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[12px] border border-[var(--ds-border)] bg-[var(--ds-card-strong)] px-4 text-[13px] font-medium text-[var(--ds-ink)] shadow-sm transition hover:bg-[var(--ds-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]/30"
              >
                <Square className="h-3.5 w-3.5 fill-current" strokeWidth={1.75} />
                {t('legalResearchStop')}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                disabled={!query.trim()}
                className="inline-flex h-10 shrink-0 items-center justify-center rounded-[12px] border border-[var(--ds-accent)]/20 bg-[var(--ds-accent)] px-5 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]/30 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {t('legalResearchStart')}
              </button>
            )}
          </div>
          <p className="mt-2 px-1 text-[11px] text-[var(--ds-faint)]">{t('legalResearchHint')}</p>
          {legalSourcesMissingToken && (
            <div className="mt-2 flex items-start gap-1.5 rounded-[12px] border border-[var(--ds-accent)]/20 bg-[var(--ds-accent)]/[0.06] px-3 py-2 text-[11px] leading-4 text-[var(--ds-muted)]">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-accent)]" strokeWidth={1.75} />
              <span>
                {t('legalResearchTokenTip')}
                <a
                  href="https://mcp.pkulaw.com/console/apps"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 text-[var(--ds-accent)] underline hover:opacity-80"
                >
                  {t('legalResearchTokenTipConfigure')}
                </a>
              </span>
            </div>
          )}
        </div>
      </header>

      {hasActiveReport && activeRecord ? (
        <div className="shrink-0 border-b border-[var(--ds-border)] px-6 py-2.5">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
            <div
              className={`min-w-0 truncate text-[11px] ${
                exportNotice?.tone === 'error' ? 'text-[var(--ds-danger)]' : 'text-[var(--ds-faint)]'
              }`}
              title={exportNotice?.text}
            >
              {exportNotice?.text ?? ''}
            </div>
            <div data-control-hover-root className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setEditingRecordId(activeRecord.id)}
                disabled={activeRecord.status === 'running'}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[12px] border border-[var(--ds-border)] bg-[var(--ds-card-soft)] px-3 text-[12px] font-medium text-[var(--ds-ink)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]/30 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <FilePenLine className="h-3.5 w-3.5" strokeWidth={1.75} />
                {t('legalResearchEditReport')}
              </button>
              <button
                type="button"
                onClick={handleExportWord}
                disabled={exportFormat !== null}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[12px] border border-[var(--ds-border)] bg-[var(--ds-card-soft)] px-3 text-[12px] font-medium text-[var(--ds-ink)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]/30 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <FileDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                {exportFormat === 'word' ? t('legalResearchExportingWord') : t('legalResearchExportWord')}
              </button>
              <button
                type="button"
                onClick={handleExportMarkdown}
                disabled={exportFormat !== null}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[12px] border border-[var(--ds-border)] bg-[var(--ds-card-soft)] px-3 text-[12px] font-medium text-[var(--ds-ink)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]/30 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <FileText className="h-3.5 w-3.5" strokeWidth={1.75} />
                {exportFormat === 'markdown'
                  ? t('legalResearchExportingMarkdown')
                  : t('legalResearchExportMarkdown')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={handleResultsScroll}
        onWheel={handleResultsWheel}
        onPointerDown={handleResultsPointerDown}
        onPointerUp={handleResultsPointerEnd}
        onPointerCancel={handleResultsPointerEnd}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-6 py-5"
      >
        {!activeRecord ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-[16px] border border-[var(--ds-border)] bg-[var(--ds-card-soft)] text-[var(--ds-muted)] shadow-sm">
              <Scale className="h-6 w-6" strokeWidth={1.6} />
            </span>
            <p className="text-[15px] font-medium text-[var(--ds-ink)]">{t('legalResearchEmptyState')}</p>
            <p className="mt-1 text-[12px] text-[var(--ds-faint)]">{t('legalResearchEmptyStateHint')}</p>
          </div>
        ) : (
          <div ref={scrollContentRef} className="mx-auto max-w-5xl space-y-4">
            <section className="rounded-[16px] border border-[var(--ds-border)] bg-[var(--ds-card-soft)] px-5 py-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-[var(--ds-faint)]">{t('legalResearchQuestion')}</p>
                  <h3 className="mt-1 text-[16px] font-medium leading-6 text-[var(--ds-ink)]">
                    {activeRecord.query}
                  </h3>
                </div>
                <span
                  className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium ${
                    activeRecord.status === 'running'
                      ? 'border-[var(--ds-accent)]/20 bg-[var(--ds-accent-soft)] text-[var(--ds-accent)]'
                      : activeRecord.status === 'done'
                        ? 'border-[var(--ds-success)]/20 bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
                        : 'border-[var(--ds-danger)]/20 bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]'
                  }`}
                >
                  {activeRecord.status === 'running' ? (
                    <ThinkingOrbStatus state={orbStateForResearchPhase(activeRecord)} size={20} />
                  ) : activeRecord.status === 'done' ? (
                    <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                  ) : (
                    <CircleAlert className="h-3.5 w-3.5" strokeWidth={1.9} />
                  )}
                  {activeRecord.status === 'running'
                    ? t('legalResearchInProgress')
                    : activeRecord.status === 'done'
                      ? t('legalResearchStepDone')
                      : t('legalResearchStepError')}
                </span>
              </div>
              <p className="mt-2 text-[11px] text-[var(--ds-faint)]">{activeRecord.timestamp}</p>
            </section>

            {activeRecord.status === 'running' ? (
              <div className="legal-research-live-strip sticky top-0 z-10 overflow-hidden rounded-[16px] border border-[var(--ds-border)] bg-[var(--ds-card-strong)] px-4 py-3 shadow-sm">
                <div className="relative z-[1] flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--ds-muted)]">
                  <span className="flex items-center gap-2 font-medium text-[var(--ds-ink)]">
                    <ThinkingOrbStatus state={orbStateForResearchLive(activeRecord)} size={20} />
                    <span className="ds-shiny-text">{t('legalResearchLiveStatus')}</span>
                  </span>
                  <span>{t('legalResearchLastUpdate', { time: formatDuration(runningSince) })}</span>
                  {currentTool ? (
                    <span className="inline-flex min-w-0 items-center gap-1.5 truncate rounded-full border border-[var(--ds-accent)]/20 bg-[var(--ds-accent-soft)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--ds-accent)]">
                      <span aria-hidden className="legal-research-stream-caret" />
                      <span className="truncate">{t('legalResearchCurrentTool', { tool: currentTool })}</span>
                    </span>
                  ) : (
                    <span className="min-w-0 truncate text-[var(--ds-faint)]">
                      {t('legalResearchWaitingForUpdate')}
                    </span>
                  )}
                </div>
              </div>
            ) : null}

            {showResearchPlan && activeRecord ? (
              <section
                className="overflow-hidden rounded-[16px] border border-[var(--ds-border)] bg-[var(--ds-card-soft)] shadow-sm"
                aria-live="polite"
                aria-busy={isResearchPlanStreaming}
              >
                <div className="flex items-center justify-between gap-4 border-b border-[var(--ds-border-muted)] px-4 py-3.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[var(--ds-accent-soft)] text-[var(--ds-accent)]">
                      <BrainCircuit className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-semibold text-[var(--ds-ink)]">{t('legalResearchReasoning')}</h3>
                      <p className="mt-0.5 text-[11px] text-[var(--ds-faint)]">{t('legalResearchPlanHint')}</p>
                    </div>
                  </div>
                  <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-medium ${
                    isResearchPlanStreaming
                      ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent)]'
                      : 'bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
                  }`}>
                    {isResearchPlanStreaming ? (
                      <ThinkingOrbStatus state="solving" size={20} />
                    ) : (
                      <CheckCircle2 className="h-3 w-3" strokeWidth={1.9} />
                    )}
                    {isResearchPlanStreaming ? t('legalResearchPlanStreaming') : t('legalResearchPlanReady')}
                  </span>
                </div>
                <div className="px-4 py-2.5">
                  {researchPlanItems.length > 0 ? (
                    <div className="divide-y divide-[var(--ds-border-muted)]">
                      {researchPlanItems.map((item, index) => {
                        const isStreamingItem = isResearchPlanStreaming && index === researchPlanItems.length - 1
                        return (
                          <div key={formatResearchPlanIndex(index)} className="flex items-start gap-3 py-3 first:pt-2 last:pb-2">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border border-[var(--ds-accent)]/15 bg-[var(--ds-accent-soft)] text-[10px] font-semibold tabular-nums text-[var(--ds-accent)]">
                              {formatResearchPlanIndex(index)}
                            </span>
                            <p className="min-w-0 flex-1 pt-0.5 text-[13px] leading-6 text-[var(--ds-muted)] [overflow-wrap:anywhere]">
                              {item}
                              {isStreamingItem ? <span aria-hidden className="legal-research-stream-caret ml-0.5" /> : null}
                            </p>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 py-2 text-[12px] text-[var(--ds-faint)]">
                      <ThinkingOrbStatus state="solving" size={20} />
                      <span>{t('legalResearchReasoningProcessing')}</span>
                    </div>
                  )}
                </div>
              </section>
            ) : null}

            {visibleResearchUpdates.length > 0 ? (
              <section className="overflow-hidden rounded-[16px] border border-[var(--ds-border)] bg-[var(--ds-card-soft)] shadow-sm">
                <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-border-muted)] px-4 py-3">
                  <div className="flex items-center gap-2">
                    <MessageSquareText className="h-4 w-4 text-[var(--ds-muted)]" strokeWidth={1.75} />
                    <h3 className="text-[13px] font-semibold text-[var(--ds-ink)]">
                      {t('legalResearchUpdatesTitle')}
                    </h3>
                  </div>
                  <span className="text-[11px] text-[var(--ds-faint)]">
                    {t('legalResearchUpdateCount', { count: visibleResearchUpdates.length })}
                  </span>
                </div>
                <div className="divide-y divide-[var(--ds-border-muted)]">
                  {visibleResearchUpdates.map((update, index) => {
                    const isCurrent = activeRecord.status === 'running' && update.completed !== true
                    // Use the stage number the model wrote in its own
                    // announcement when present (阶段四/第5阶段), falling back
                    // to the sequential index otherwise.
                    const stageNumber = extractStageNumber(update.text) ?? index + 1
                    return (
                      <div key={update.id} className="legal-research-step flex gap-3 px-4 py-3">
                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--ds-border)] bg-[var(--ds-card-strong)] text-[11px] font-semibold text-[var(--ds-muted)]">
                          {stageNumber}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex items-center justify-between gap-3">
                            <span className="text-[11px] font-medium text-[var(--ds-faint)]">
                              {t('legalResearchUpdatesTitle')} {stageNumber}
                            </span>
                            {isCurrent ? (
                              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--ds-accent)]">
                                <ThinkingOrbStatus state={orbStateForResearchText(update.text)} size={20} />
                                {t('legalResearchUpdateStreaming')}
                              </span>
                            ) : (
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--ds-success)]" />
                            )}
                          </div>
                          <div className="ds-markdown max-w-none text-[13px] leading-6 text-[var(--ds-muted)] [overflow-wrap:anywhere]">
                            <StableAssistantMarkdown text={update.text} streaming={isCurrent} />
                            {isCurrent ? <span aria-hidden className="legal-research-stream-caret" /> : null}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            ) : null}

            {hasActiveReport ? (
              <section
                className="legal-research-report overflow-hidden rounded-[16px] border border-[var(--ds-border)] bg-[var(--ds-card-soft)] shadow-sm"
                aria-live="polite"
              >
                <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-border-muted)] px-4 py-3">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-[var(--ds-muted)]" strokeWidth={1.75} />
                    <h3 className="text-[13px] font-semibold text-[var(--ds-ink)]">
                      {t('legalResearchSummaryTitle')}
                    </h3>
                  </div>
                  <CheckCircle2 className="h-4 w-4 text-[var(--ds-success)]" strokeWidth={1.75} />
                </div>
                <div className="px-5 py-4">
                  {resolvedReport ? (
                    <div className="ds-markdown ds-chat-answer max-w-none text-[15px] leading-relaxed text-[var(--ds-ink)] [overflow-wrap:anywhere]">
                      <StableAssistantMarkdown
                        key={`${activeRecord.id}:${activeRecord.reportRevision ?? 'generated'}`}
                        text={resolvedReport}
                        streaming={false}
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 py-2" aria-label={t('legalResearchReportDrafting')}>
                      <ThinkingOrbStatus state="composing" size={20} />
                      <div className="legal-research-stream-placeholder flex-1">
                        <span />
                        <span />
                        <span />
                      </div>
                    </div>
                  )}
                </div>
              </section>
            ) : null}

            {activeRecord.error ? (
              <div className="flex items-start gap-2 rounded-[16px] border border-[var(--ds-danger)]/25 bg-[var(--ds-danger-soft)] px-4 py-3">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ds-danger)]" strokeWidth={1.8} />
                <p className="text-[13px] leading-5 text-[var(--ds-danger)]">{activeRecord.error}</p>
              </div>
            ) : null}
          </div>
        )}
      </div>
      {activeRecord && editingRecordId === activeRecord.id && (
        <LegalResearchEditorDialog
          initialMarkdown={resolveLegalResearchMarkdown(activeRecord)}
          onClose={() => setEditingRecordId(null)}
          onSave={handleSaveEditedReport}
        />
      )}
    </div>
  )
}

/** 北大法宝 / 元典 MCP 端点的 id 前缀（与插件市场 PluginMarketplaceView 保持一致）。 */
const LEGAL_SOURCE_SERVER_ID_PREFIXES = ['pkulaw', 'yuandian']

/**
 * 判断 MCP 配置中北大法宝与元典是否至少有一个配置了访问 Token。
 * 返回 true = 至少有一个已配置；false = 两个都未配置（应提示用户）。
 * 仅读取配置 JSON，不涉及任何 token 明文。
 */
export function hasAnyLegalSourceToken(configContent: string): boolean {
  try {
    const parsed = JSON.parse(configContent) as {
      servers?: Record<string, { headers?: Record<string, string> }>
      capabilities?: { mcp?: { servers?: Record<string, { headers?: Record<string, string> }> } }
    }
    const servers =
      (typeof parsed === 'object' && parsed !== null && parsed.servers
        ? parsed.servers
        : parsed.capabilities?.mcp?.servers) ?? {}
    return LEGAL_SOURCE_SERVER_ID_PREFIXES.some((prefix) => {
      const matched = Object.entries(servers).filter(([id]) => id.startsWith(prefix))
      if (matched.length === 0) return false
      return matched.some(([, server]) => {
        const headers = server?.headers ?? {}
        const authorization = Object.entries(headers).find(
          ([key]) => key.toLowerCase() === 'authorization'
        )?.[1]
        return typeof authorization === 'string' && authorization.trim().length > 0
      })
    })
  } catch {
    // 配置解析失败时保守判定为"已配置"，避免误提示打扰用户。
    return true
  }
}
