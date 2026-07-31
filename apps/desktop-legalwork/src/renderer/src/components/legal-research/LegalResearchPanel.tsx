import type { ReactElement } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BookOpenText,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileSearch,
  FileDown,
  FilePenLine,
  FileText,
  Globe2,
  LoaderCircle,
  MessageSquareText,
  Scale,
  Search,
  ScrollText,
  Square
} from 'lucide-react'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import type { ResearchStep, ReturnUseLegalResearch } from './useLegalResearch'
import {
  preprocessLegalResearchSummary,
  resolveLegalResearchMarkdown
} from './legal-research-markdown'
import { LegalResearchEditorDialog } from './LegalResearchEditorDialog'

export type LegalResearchPanelProps = {
  legalResearch: ReturnUseLegalResearch
}

function ResearchToolIcon({ step }: { step: ResearchStep }): ReactElement {
  const tool = `${step.icon} ${step.tool} ${String(step.meta?.toolName ?? '')}`.toLowerCase()
  const iconClassName = 'h-4 w-4'
  if (tool.includes('case') || tool.includes('案例') || tool.includes('判例')) {
    return <Scale className={iconClassName} strokeWidth={1.75} />
  }
  if (
    tool.includes('paper')
    || tool.includes('literature')
    || tool.includes('文献')
    || tool.includes('cnki')
    || tool.includes('academic')
  ) {
    return <BookOpenText className={iconClassName} strokeWidth={1.75} />
  }
  if (
    tool.includes('web')
    || tool.includes('fetch')
    || tool.includes('网页')
    || tool.includes('提取')
  ) {
    return <Globe2 className={iconClassName} strokeWidth={1.75} />
  }
  if (
    tool.includes('regulation')
    || tool.includes('法规')
    || tool.includes('条文')
    || tool.includes('summary')
  ) {
    return <ScrollText className={iconClassName} strokeWidth={1.75} />
  }
  return <FileSearch className={iconClassName} strokeWidth={1.75} />
}

export function LegalResearchPanel({ legalResearch }: LegalResearchPanelProps): ReactElement {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const [reasoningExpanded, setReasoningExpanded] = useState(false)
  const [clockNow, setClockNow] = useState(Date.now())
  const [exportFormat, setExportFormat] = useState<'word' | 'markdown' | null>(null)
  const [exportNotice, setExportNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null)
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

  useEffect(() => {
    if (!isResearching || activeRecord?.status !== 'running') return
    setClockNow(Date.now())
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activeRecord?.id, activeRecord?.status, isResearching])

  useLayoutEffect(() => {
    stickToBottomRef.current = true
    const frame = window.requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeRecord?.id])

  useEffect(() => {
    setEditingRecordId(null)
  }, [activeRecord?.id])

  useEffect(() => {
    if (!isResearching || !stickToBottomRef.current) return
    const frame = window.requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeRecord?.steps, activeRecord?.reasoning, activeRecord?.summary, activeRecord?.error, clockNow, isResearching])

  const handleResultsScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    stickToBottomRef.current = distanceFromBottom < 140
  }, [])

  const handleStart = useCallback(() => {
    if (!query.trim() || isResearching) return
    void runResearch(query.trim())
    setQuery('')
  }, [query, isResearching, runResearch])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleStart()
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

  // Extract key actions from reasoning text
  const extractKeyActions = (reasoning: string): string[] => {
    const actions: string[] = []
    const lines = reasoning.split('\n')
    
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      
      // Match patterns like "1. Search for...", "Let me...", "I'll...", "I need to..."
      if (
        /^\d+\./.test(trimmed) ||
        /^(Let me|I'll|I need to|I should|Now I|Next I|First|Then|Finally|I will|I am going to)/i.test(trimmed) ||
        /^(搜索|查找|检索|调用|使用|开始|现在|接下来|首先|然后|最后)/i.test(trimmed)
      ) {
        // Truncate long lines
        const short = trimmed.length > 120 ? trimmed.slice(0, 120) + '...' : trimmed
        actions.push(short)
      }
    }
    
    return actions.slice(0, 8) // Limit to 8 key actions
  }

  // Split reasoning text into sentences for readable multi-line display
  const splitSentences = (text: string): string[] => {
    if (!text.trim()) return []
    // Split by Chinese/English sentence terminators, keeping the delimiter
    const raw = text.split(/(?<=[。！？.!?])\s*/).filter(Boolean)
    // Merge very short fragments (< 6 chars) with the previous sentence
    const merged: string[] = []
    for (const part of raw) {
      const trimmed = part.trim()
      if (!trimmed) continue
      if (merged.length > 0 && trimmed.length < 6) {
        merged[merged.length - 1] += ' ' + trimmed
      } else {
        merged.push(trimmed)
      }
    }
    return merged
  }

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
  const runningSteps = activeRecord?.steps.filter((step) => step.status === 'running') ?? []
  const lastRunningStep = runningSteps[runningSteps.length - 1]
  const runningSince = activeRecord?.status === 'running' ? clockNow - updatedAt : 0
  const hasActiveReport = Boolean(
    activeRecord
      && activeRecord.status !== 'running'
      && (activeRecord.summary || activeRecord.editedSummary !== undefined)
  )
  const resolvedReport = activeRecord
    ? preprocessLegalResearchSummary(resolveLegalResearchMarkdown(activeRecord))
    : ''
  const keyActions = activeRecord?.reasoning ? extractKeyActions(activeRecord.reasoning) : []
  const researchUpdates = activeRecord?.updates ?? []
  const visibleResearchUpdates = activeRecord?.status === 'running'
    ? researchUpdates
    : researchUpdates.slice(0, -1)

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
          <div className="mx-auto max-w-5xl space-y-4">
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
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
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
              <div className="legal-research-live-strip sticky top-0 z-10 overflow-hidden rounded-[16px] border border-[var(--ds-border)] bg-[var(--ds-card-strong)] px-4 py-3 shadow-sm backdrop-blur">
                <div className="relative z-[1] flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--ds-muted)]">
                  <span className="flex items-center gap-2 font-medium text-[var(--ds-ink)]">
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--ds-accent)] opacity-30" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--ds-accent)]" />
                    </span>
                    <span className="ds-shiny-text">{t('legalResearchLiveStatus')}</span>
                  </span>
                  <span>{t('legalResearchLastUpdate', { time: formatDuration(runningSince) })}</span>
                  <span className="min-w-0 truncate text-[var(--ds-faint)]">
                    {lastRunningStep?.tool || t('legalResearchWaitingForUpdate')}
                  </span>
                </div>
              </div>
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
                    return (
                      <div key={update.id} className="legal-research-step flex gap-3 px-4 py-3">
                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--ds-border)] bg-[var(--ds-card-strong)] text-[11px] font-semibold text-[var(--ds-muted)]">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex items-center justify-between gap-3">
                            <span className="text-[11px] font-medium text-[var(--ds-faint)]">
                              {t('legalResearchUpdatesTitle')} {index + 1}
                            </span>
                            {isCurrent ? (
                              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--ds-accent)]">
                                <LoaderCircle className="h-3 w-3 animate-spin" />
                                {t('legalResearchUpdateStreaming')}
                              </span>
                            ) : (
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--ds-success)]" />
                            )}
                          </div>
                          <div className="ds-markdown max-w-none text-[13px] leading-6 text-[var(--ds-muted)] [overflow-wrap:anywhere]">
                            <AssistantMarkdown text={update.text} streaming={isCurrent} />
                            {isCurrent ? <span aria-hidden className="legal-research-stream-caret" /> : null}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            ) : null}

            {activeRecord.steps.length > 0 ? (
              <section className="overflow-hidden rounded-[16px] border border-[var(--ds-border)] bg-[var(--ds-card-soft)] shadow-sm">
                <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-border-muted)] px-4 py-3">
                  <div className="flex items-center gap-2">
                    <FileSearch className="h-4 w-4 text-[var(--ds-muted)]" strokeWidth={1.75} />
                    <h3 className="text-[13px] font-semibold text-[var(--ds-ink)]">
                      {t('legalResearchProgressTitle')}
                    </h3>
                  </div>
                  <span className="text-[11px] text-[var(--ds-faint)]">
                    {t('legalResearchStepCount', { count: activeRecord.steps.length })}
                  </span>
                </div>
                <div className="divide-y divide-[var(--ds-border-muted)]">
                  {activeRecord.steps.map((step) => (
                    <div key={step.id} className="legal-research-step flex gap-3 px-4 py-3">
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[12px] border border-[var(--ds-border)] bg-[var(--ds-card-strong)] text-[var(--ds-muted)]">
                        <ResearchToolIcon step={step} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-3">
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ds-ink)]">
                            {step.tool}
                          </span>
                          <span
                            className={`inline-flex shrink-0 items-center gap-1 text-[11px] ${
                              step.status === 'running'
                                ? 'text-[var(--ds-accent)]'
                                : step.status === 'done'
                                  ? 'text-[var(--ds-success)]'
                                  : step.status === 'error'
                                    ? 'text-[var(--ds-danger)]'
                                    : 'text-[var(--ds-faint)]'
                            }`}
                          >
                            {step.status === 'running' ? (
                              <LoaderCircle className="h-3 w-3 animate-spin" />
                            ) : step.status === 'done' ? (
                              <CheckCircle2 className="h-3 w-3" />
                            ) : step.status === 'error' ? (
                              <CircleAlert className="h-3 w-3" />
                            ) : null}
                            {step.status === 'running'
                              ? t('legalResearchStepRunning')
                              : step.status === 'done'
                                ? t('legalResearchStepDone')
                                : step.status === 'error'
                                  ? t('legalResearchStepError')
                                  : null}
                          </span>
                        </div>
                        {step.output ? (
                          <p className="mt-1 text-[12px] leading-5 text-[var(--ds-muted)] [overflow-wrap:anywhere]">
                            {step.output}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {activeRecord.reasoning ? (
              <section className="overflow-hidden rounded-[16px] border border-[var(--ds-border)] bg-[var(--ds-card-soft)] shadow-sm">
                <button
                  type="button"
                  onClick={() => setReasoningExpanded(!reasoningExpanded)}
                  aria-expanded={reasoningExpanded}
                  className="flex w-full items-center gap-2 rounded-[12px] px-4 py-3 text-left transition hover:bg-[var(--ds-sidebar-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent)]/30"
                >
                  <BrainCircuit className="h-4 w-4 text-[var(--ds-muted)]" strokeWidth={1.75} />
                  <span className="text-[13px] font-semibold text-[var(--ds-ink)]">{t('legalResearchReasoning')}</span>
                  {activeRecord.status === 'running' ? (
                    <span className="ds-shiny-text text-[11px]">{t('legalResearchReasoningProcessing')}</span>
                  ) : null}
                  <span className="ml-auto text-[11px] text-[var(--ds-faint)]">
                    {reasoningExpanded ? t('legalResearchCollapse') : t('legalResearchExpand')}
                  </span>
                  {reasoningExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5 text-[var(--ds-faint)]" strokeWidth={1.75} />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-[var(--ds-faint)]" strokeWidth={1.75} />
                  )}
                </button>
                <div className="border-t border-[var(--ds-border-muted)] px-4 py-3">
                  {!reasoningExpanded ? (
                    <div className="space-y-2">
                      {keyActions.map((action, index) => (
                        <div key={`${index}-${action}`} className="flex items-start gap-2.5 text-[12px] text-[var(--ds-muted)]">
                          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ds-accent)]" />
                          <span className="leading-5">{action}</span>
                        </div>
                      ))}
                      {keyActions.length === 0 ? (
                        <p className="text-[12px] italic text-[var(--ds-faint)]">
                          {t('legalResearchReasoningProcessing')}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {splitSentences(activeRecord.reasoning).map((sentence, index) => (
                        <p key={`${index}-${sentence}`} className="text-[13px] leading-6 text-[var(--ds-muted)]">
                          {sentence}
                        </p>
                      ))}
                    </div>
                  )}
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
                      <AssistantMarkdown
                        key={`${activeRecord.id}:${activeRecord.reportRevision ?? 'generated'}`}
                        text={resolvedReport}
                        streaming={false}
                      />
                    </div>
                  ) : (
                    <div className="legal-research-stream-placeholder py-2" aria-label={t('legalResearchReportDrafting')}>
                      <span />
                      <span />
                      <span />
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
            <div ref={bottomRef} aria-hidden="true" />
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
