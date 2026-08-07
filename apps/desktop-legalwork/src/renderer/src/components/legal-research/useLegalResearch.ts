import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getProvider } from '../../agent/registry'
import type { ChatBlock, ThreadDeltaEvent, ThreadEventSink, ToolEventPayload } from '../../agent/types'
import { applyLegalResearchSummaryEdit } from './legal-research-records'
import { isResearchPlanMessage } from './legal-research-plan'

type ResearchStepStatus = 'pending' | 'running' | 'done' | 'error'

export interface ResearchStep {
  id: string
  tool: string
  icon: string
  status: ResearchStepStatus
  input: string
  output?: string
  detail?: string
  meta?: Record<string, unknown>
}

export interface ResearchUpdate {
  id: string
  text: string
  createdAt: string
  completed?: boolean
}

export interface ResearchRecord {
  id: string
  query: string
  timestamp: string
  updatedAt?: number
  status: 'running' | 'done' | 'error'
  blocks: ChatBlock[]
  steps: ResearchStep[]
  updates: ResearchUpdate[]
  summary: string
  editedSummary?: string
  reportRevision?: number
  reasoning: string
  threadId: string
  turnId?: string
  error?: string
}

const STORAGE_KEY = 'legalwork.legal-research.records'
const RECORDS_PERSIST_DELAY_MS = 240

function mapToolStatus(status: ToolEventPayload['status']): ResearchStepStatus {
  if (status === 'success') return 'done'
  return status
}

function iconForTool(toolName?: string, summary?: string): string {
  const text = `${toolName ?? ''} ${summary ?? ''}`.toLowerCase()
  if (text.includes('search') || text.includes('搜索')) return 'search'
  if (text.includes('case') || text.includes('案例') || text.includes('判例')) return 'case'
  if (text.includes('paper') || text.includes('文献') || text.includes('cnki')) return 'literature'
  if (text.includes('regulation') || text.includes('law') || text.includes('法规') || text.includes('条文')) return 'regulation'
  if (text.includes('synthesis') || text.includes('summar') || text.includes('总结') || text.includes('综述')) return 'summary'
  if (text.includes('web') || text.includes('fetch') || text.includes('提取')) return 'web'
  return 'tool'
}

function loadRecords(): ResearchRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ResearchRecord[]
    return Array.isArray(parsed)
      ? parsed.map((record) => ({
          ...record,
          blocks: record.blocks ?? [],
          steps: record.steps ?? [],
          updates: record.updates ?? []
        }))
      : []
  } catch {
    return []
  }
}

function saveRecords(records: ResearchRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

export function useLegalResearch() {
  const { t } = useTranslation('common')
  const [records, setRecords] = useState<ResearchRecord[]>(loadRecords)
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null)
  const [isResearching, setIsResearching] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const recordsRef = useRef(records)
  const persistTimerRef = useRef<number | null>(null)

  const activeRecord = records.find((r) => r.id === activeRecordId) ?? null

  useEffect(() => {
    recordsRef.current = records
    if (persistTimerRef.current !== null) return
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null
      saveRecords(recordsRef.current)
    }, RECORDS_PERSIST_DELAY_MS)
  }, [records])

  useEffect(() => () => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    saveRecords(recordsRef.current)
  }, [])

  const persist = useCallback((next: ResearchRecord[] | ((prev: ResearchRecord[]) => ResearchRecord[])) => {
    setRecords((prev) => typeof next === 'function' ? next(prev) : next)
  }, [])

  const buildResearchPrompt = useCallback(
    (query: string) =>
      t('legalResearchAgentPrompt', {
        query,
        defaultValue:
          '请对以下法律问题进行多源调研：「{{query}}」。\n\n【重要要求】\n1. 所有可见过程播报与最终报告使用中文。\n2. 调研开始前先形成简洁但完整的调研规划。规划回答“准备核验什么、怎么检索、从哪些来源取得依据、如何比较并形成结论”，每项必须是针对本题的可执行调研动作，通常使用“核验、检索、比较、复核、综合”等动词开头。可根据问题复杂度自主决定步骤数量。不要把“形成规划、使用编号、输出中文、阶段播报、最终报告”等格式或交付要求写成规划步骤；不要写工具可用性判断、调用尝试、“我应该……”等内部思考。\n3. 由 Agent 根据具体问题自主决定调用哪些工具、调用次数和检索路径，不要求机械地调用全部来源或遵循固定步骤。来源定位上，已配置北大法宝 MCP 时，将北大法宝作为法规与案例的默认主来源；按需使用其引证核验与链接增强工具。IMA 与本地知识库作为补充来源，用于学术观点、内部材料和实务参考，不得因自动路由被强制置于北大法宝之前。\n4. 国家法律法规数据库不是强制来源。仅在用户明确指定、北大法宝不可用/无结果或不同来源对效力状态存在重大冲突时按需使用；不得仅为取得官方链接而查询，也不得为访问国家库调用用户浏览器、Chrome 或 Playwright。\n5. 规划完成后再开始检索；每完成一个检索阶段，可用一条简短消息说明“已完成什么、得到什么、下一步是什么”，不要把多个阶段压成一个长段落，也不要输出冗长工具日志。\n6. 某个可选来源失败时最多换用一个已配置的非浏览器来源；不要反复重试。资料仍无法核验时如实标注，不阻塞最终报告。\n7. 最终报告必须作为最后一条独立回复，以 Markdown 分级标题组织，至少区分：结论、法律依据、相关案例、分析与风险提示、来源。保留工具返回的完整真实 URL，不得自行拼接或猜测。'
      }),
    [t]
  )

  const runResearch = useCallback(
    async (query: string) => {
      if (!query.trim() || isResearching) return

      const trimmedQuery = query.trim()
      const recordId = `research-${Date.now()}`

      abortRef.current?.abort()
      abortRef.current = new AbortController()
      const signal = abortRef.current.signal

      setIsResearching(true)

      let threadId = ''
      let turnId = ''

      try {
        const provider = getProvider()
        // Research runs in a dedicated internal workspace so its threads are
        // excluded from the home agent's code-thread list (isCodeThread) and
        // never surface in the main conversation view.
        const workspaceRoot = '~/.legalwork/research-workspace'

        const thread = await provider.createThread({
          workspace: workspaceRoot,
          title: `${t('legalResearch')}: ${trimmedQuery.slice(0, 60)}`,
          mode: 'agent'
        })
        threadId = thread.id

        const initialRecord: ResearchRecord = {
          id: recordId,
          query: trimmedQuery,
          timestamp: new Date().toLocaleString('zh-CN', { hour12: false }),
          updatedAt: Date.now(),
          status: 'running',
          blocks: [],
          steps: [],
          updates: [],
          summary: '',
          reasoning: '',
          threadId
        }

        persist((prev) => [initialRecord, ...prev])
        setActiveRecordId(recordId)

        const sendResult = await provider.sendUserMessage(threadId, buildResearchPrompt(trimmedQuery), {
          mode: 'agent'
        })
        turnId = sendResult.turnId

        persist((prev) =>
          prev.map((r) => (r.id === recordId ? { ...r, turnId } : r))
        )

        const assistantSegments = new Map<string, ResearchUpdate>()
        const assistantSegmentOrder: string[] = []
        let reasoningText = ''
        let capturePlanningReasoning = true
        const toolSteps = new Map<string, ResearchStep>()
        const blockMap = new Map<string, ChatBlock>()

        function upsertBlock(block: ChatBlock): void {
          blockMap.set(block.id, block)
        }

        function flushBlocks(): ChatBlock[] {
          return [...blockMap.values()]
        }

        function flushUpdates(): ResearchUpdate[] {
          return assistantSegmentOrder
            .map((id) => assistantSegments.get(id))
            .filter((update): update is ResearchUpdate => (
              Boolean(update?.text.trim()) && !isResearchPlanMessage(update?.text ?? '')
            ))
        }

        function latestAssistantText(): string {
          const latestId = assistantSegmentOrder[assistantSegmentOrder.length - 1]
          return latestId ? assistantSegments.get(latestId)?.text.trim() ?? '' : ''
        }

        function completeAssistantUpdates(): void {
          for (const [id, update] of assistantSegments) {
            assistantSegments.set(id, { ...update, completed: true })
          }
        }

        // Batch the high-frequency delta updates (planning reasoning can
        // stream thousands of deltas) into at most one state commit per
        // animation frame. Otherwise every SSE flush forces a full record
        // rewrite (blocks array + reasoning reparse in the panel) and the
        // renderer starves, dropping subsequent SSE events — leaving the UI
        // stuck on "planning" long after the runtime finished the turn.
        let pendingRecordPatch: Partial<ResearchRecord> | null = null
        let recordFlushFrame = 0
        const flushRecord = (): void => {
          recordFlushFrame = 0
          const patch = pendingRecordPatch
          pendingRecordPatch = null
          if (!patch) return
          persist((prev) =>
            prev.map((r) =>
              r.id === recordId
                ? { ...r, ...patch, updatedAt: Date.now(), blocks: flushBlocks() }
                : r
            )
          )
        }
        const scheduleRecordUpdate = (next: Partial<ResearchRecord>): void => {
          pendingRecordPatch = { ...pendingRecordPatch, ...next }
          if (recordFlushFrame) return
          recordFlushFrame = window.requestAnimationFrame(flushRecord)
        }
        const commitRecordUpdate = (next: Partial<ResearchRecord>): void => {
          scheduleRecordUpdate(next)
          if (recordFlushFrame) {
            window.cancelAnimationFrame(recordFlushFrame)
            recordFlushFrame = 0
          }
          flushRecord()
        }

        let terminalEventReceived = false
        let surfacedError = ''
        const sink: ThreadEventSink = {
          onSeq: () => {},
          onDeltas: (deltas: ThreadDeltaEvent[]) => {
            let planningReasoningChanged = false
            for (const delta of deltas) {
              if (delta.kind === 'agent_message') {
                const segmentId = delta.itemId || 'assistant-current'
                const existing = assistantSegments.get(segmentId)
                if (!existing) {
                  completeAssistantUpdates()
                  assistantSegmentOrder.push(segmentId)
                }
                assistantSegments.set(segmentId, {
                  id: segmentId,
                  text: `${existing?.text ?? ''}${delta.text}`,
                  createdAt: existing?.createdAt ?? new Date().toISOString(),
                  completed: false
                })
                upsertBlock({
                  kind: 'assistant',
                  id: segmentId,
                  createdAt: assistantSegments.get(segmentId)?.createdAt,
                  text: assistantSegments.get(segmentId)?.text.trim() ?? ''
                })
              } else if (delta.kind === 'agent_reasoning' && capturePlanningReasoning) {
                reasoningText += delta.text
                planningReasoningChanged = true
              }
            }
            if (planningReasoningChanged && reasoningText.trim()) {
              upsertBlock({
                kind: 'reasoning',
                id: 'reasoning',
                createdAt: new Date().toISOString(),
                text: reasoningText.trim()
              })
            }
            scheduleRecordUpdate({
              updates: flushUpdates(),
              summary: latestAssistantText(),
              ...(planningReasoningChanged ? { reasoning: reasoningText.trim() } : {})
            })
          },
          onUserMessage: (ev) => {
            upsertBlock({
              kind: 'user',
              id: ev.itemId || 'user',
              createdAt: ev.createdAt || new Date().toISOString(),
              text: ev.text,
              modelLabel: ev.modelLabel
            })
            scheduleRecordUpdate({})
          },
          onTool: (ev: ToolEventPayload) => {
            capturePlanningReasoning = false
            completeAssistantUpdates()
            const existing = toolSteps.get(ev.itemId)
            const isError = ev.status === 'error'
            
            if (!existing) {
              const step: ResearchStep = {
                id: ev.itemId,
                tool: ev.summary || t('legalResearchToolUnknown'),
                icon: isError ? 'error' : iconForTool(ev.meta?.toolName as string | undefined, ev.summary),
                status: isError ? 'error' : mapToolStatus(ev.status),
                input: trimmedQuery,
                output: isError ? `调用失败：${ev.detail || '未知错误'}，将尝试其他方法...` : ev.detail,
                detail: ev.detail,
                meta: ev.meta
              }
              toolSteps.set(ev.itemId, step)
            } else {
              const updated: ResearchStep = {
                ...existing,
                status: isError ? 'error' : mapToolStatus(ev.status),
                output: isError ? `调用失败：${ev.detail || '未知错误'}，将尝试其他方法...` : ev.detail,
                detail: ev.detail,
                meta: ev.meta
              }
              toolSteps.set(ev.itemId, updated)
            }
            upsertBlock({
              kind: 'tool',
              id: ev.itemId,
              createdAt: new Date().toISOString(),
              summary: ev.summary || t('legalResearchToolUnknown'),
              status: ev.status,
              toolKind: ev.toolKind,
              detail: ev.detail,
              filePath: ev.filePath,
              meta: ev.meta
            })
            scheduleRecordUpdate({
              steps: [...toolSteps.values()],
              updates: flushUpdates()
            })
          },
          onCompaction: () => {},
          onApproval: () => {},
          onUserInput: () => {},
          onUserInputStatus: () => {},
          onGoal: () => {},
          onTurnComplete: () => {
            terminalEventReceived = true
            completeAssistantUpdates()
            const noToolsExecuted = toolSteps.size === 0
            const latestText = latestAssistantText()
            if (noToolsExecuted) {
              // The model finished the turn without invoking any tool —
              // it produced only a plan. Mark it as not-done so the UI does
              // not claim a completed research, and surface a clear hint.
              commitRecordUpdate({
                status: 'error',
                updates: flushUpdates(),
                summary: latestText || t('legalResearchNoSummary'),
                error: t('legalResearchNoToolsHint')
              })
              setIsResearching(false)
              return
            }
            // 只有真正成功完成时才标记为 done
            commitRecordUpdate({
              status: 'done',
              updates: flushUpdates(),
              summary: latestText || t('legalResearchNoSummary'),
              error: undefined // 清除之前的错误
            })
            setIsResearching(false)
          },
          onError: (err: Error) => {
            terminalEventReceived = true
            completeAssistantUpdates()
            const rawMessage = err.message?.trim() || ''
            // 保留首个具体错误，避免后续兜底/空消息覆盖真实失败原因
            if (!surfacedError && rawMessage && !/legalwork turn failed/i.test(rawMessage)) {
              surfacedError = rawMessage
            }
            commitRecordUpdate({
              status: 'error',
              error: surfacedError
                ? `${t('legalResearchTurnFailed')}${surfacedError}`
                : t('legalResearchTurnFailed'),
              updates: flushUpdates(),
              summary: latestAssistantText() || t('legalResearchNoSummary')
            })
            setIsResearching(false)
          }
        }

        await provider.subscribeThreadEvents(threadId, 0, sink, signal)
        // The runtime SSE stream is a long-lived connection that only closes
        // when the client stops it, so subscribeThreadEvents returns when the
        // stream ends (end/error/abort) rather than when the turn completes.
        // If the turn is actually done but we never saw the terminal event —
        // e.g. events were dropped while the renderer was saturated by the
        // planning-reasoning delta burst — reconcile from the persisted thread
        // so the finished stages and report surface instead of hanging forever
        // on "waiting for next update".
        if (!signal.aborted && !terminalEventReceived) {
          try {
            const detail = await provider.getThreadDetail(threadId)
            if (detail?.latestTurnId && detail.threadStatus !== 'running') {
              const recovered: ResearchUpdate[] = []
              for (const block of detail.blocks ?? []) {
                if (
                  block.kind === 'assistant' &&
                  typeof block.text === 'string' &&
                  block.text.trim() &&
                  !isResearchPlanMessage(block.text)
                ) {
                  recovered.push({
                    id: block.id,
                    text: block.text.trim(),
                    createdAt: block.createdAt ?? new Date().toISOString(),
                    completed: true
                  })
                }
              }
              const recoveredReasoning = detail.blocks
                ?.filter((b) => b.kind === 'reasoning')
                .map((b) => (typeof b.text === 'string' ? b.text : ''))
                .join('\n')
                .trim()
              if (recovered.length > 0 || recoveredReasoning) {
                assistantSegmentOrder.length = 0
                assistantSegments.clear()
                for (const update of recovered) {
                  assistantSegments.set(update.id, update)
                  assistantSegmentOrder.push(update.id)
                }
                if (recoveredReasoning) {
                  reasoningText = recoveredReasoning
                  upsertBlock({ kind: 'reasoning', id: 'reasoning', createdAt: new Date().toISOString(), text: recoveredReasoning })
                }
                const recoveredSummary =
                  recovered[recovered.length - 1]?.text ||
                  latestAssistantText() ||
                  t('legalResearchNoSummary')
                commitRecordUpdate({
                  status: 'done',
                  updates: flushUpdates(),
                  summary: recoveredSummary,
                  ...(recoveredReasoning ? { reasoning: recoveredReasoning } : {}),
                  error: undefined
                })
                setIsResearching(false)
                return
              }
            }
          } catch {
            // Reconcile is best-effort; fall through to the error state below.
          }
          commitRecordUpdate({
            status: 'error',
            error: t('legalResearchStreamEnded'),
            updates: flushUpdates(),
            summary: latestAssistantText() || t('legalResearchNoSummary')
          })
          setIsResearching(false)
        }
        // Abort path (user stopped): the last throttled deltas may still sit in
        // a pending rAF. Commit them so the record keeps its final text even if
        // the component unmounts before the animation frame fires. stopResearch
        // already set status=error; do not overwrite it here.
        if (signal.aborted && !terminalEventReceived) {
          commitRecordUpdate({})
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? 'unknown error')
        persist((prev) => {
          const existing = prev.find((r) => r.id === recordId)
          if (existing) {
            return prev.map((r) => (r.id === recordId ? { ...r, status: 'error', updatedAt: Date.now(), error: `调研启动失败：${message}` } : r))
          }
          return [
            {
              id: recordId,
              query: trimmedQuery,
              timestamp: new Date().toLocaleString('zh-CN', { hour12: false }),
              updatedAt: Date.now(),
              status: 'error',
              blocks: [],
              steps: [],
              updates: [],
              summary: '',
              reasoning: '',
              threadId,
              turnId,
              error: `初始化遇到问题：${message}`
            },
            ...prev
          ]
        })
        setActiveRecordId(recordId)
        setIsResearching(false)
      }
    },
    [isResearching, t, buildResearchPrompt, persist]
  )

  const stopResearch = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsResearching(false)
    persist((prev) =>
      prev.map((r) =>
        r.id === activeRecordId && r.status === 'running' ? { ...r, status: 'error', updatedAt: Date.now(), error: t('legalResearchStopped') } : r
      )
    )
  }, [activeRecordId, t, persist])

  const deleteRecord = useCallback(
    (id: string) => {
      persist((prev) => prev.filter((r) => r.id !== id))
      if (activeRecordId === id) setActiveRecordId(null)
    },
    [activeRecordId, persist]
  )

  const clearHistory = useCallback(() => {
    if (window.confirm(t('legalResearchClearConfirm'))) {
      persist([])
      setActiveRecordId(null)
    }
  }, [t, persist])

  const saveEditedSummary = useCallback(
    (id: string, editedSummary: string) => {
      persist((prev) => applyLegalResearchSummaryEdit(prev, id, editedSummary))
    },
    [persist]
  )

  return {
    records,
    activeRecord,
    activeRecordId,
    setActiveRecordId,
    isResearching,
    runResearch,
    stopResearch,
    saveEditedSummary,
    deleteRecord,
    clearHistory
  }
}

export type ReturnUseLegalResearch = ReturnType<typeof useLegalResearch>
