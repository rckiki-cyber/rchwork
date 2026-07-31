import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getProvider } from '../../agent/registry'
import type { ChatBlock, ThreadDeltaEvent, ThreadEventSink, ToolEventPayload } from '../../agent/types'
import { normalizeWorkspaceRoot } from '../../lib/workspace-path'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { applyLegalResearchSummaryEdit } from './legal-research-records'

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

  const activeRecord = records.find((r) => r.id === activeRecordId) ?? null

  const persist = useCallback((next: ResearchRecord[] | ((prev: ResearchRecord[]) => ResearchRecord[])) => {
    setRecords((prev) => {
      const updated = typeof next === 'function' ? next(prev) : next
      saveRecords(updated)
      return updated
    })
  }, [])

  const buildResearchPrompt = useCallback(
    (query: string) =>
      t('legalResearchAgentPrompt', {
        query,
        defaultValue:
          '请对以下法律问题进行多源调研：「{{query}}」。\n\n【重要要求】\n1. 所有可见过程播报与最终报告使用中文。\n2. 主动调用可用的 skill、知识库与法律数据库工具；已配置北大法宝 MCP 时，以北大法宝作为法规和案例的主检索来源，并使用其链接增强与引证核验工具。\n3. 国家法律法规数据库不是强制来源。仅在用户明确指定、北大法宝不可用/无结果或不同来源对效力状态存在重大冲突时按需使用；不得仅为取得官方链接而查询，也不得为访问国家库调用用户浏览器、Chrome 或 Playwright。\n4. 每完成一个检索阶段，可用一条简短消息说明“已完成什么、得到什么、下一步是什么”；不要把多个阶段压成一个长段落，也不要输出冗长的工具尝试日志。\n5. 某个可选来源失败时最多换用一个已配置的非浏览器来源；不要反复重试。资料仍无法核验时如实标注，不阻塞最终报告。\n6. 最终报告必须作为最后一条独立回复，以 Markdown 分级标题组织，至少区分：结论、法律依据、相关案例、分析与风险提示、来源。保留工具返回的完整真实 URL，不得自行拼接或猜测。\n7. 推理过程只保留关键行动，不展开长篇内部分析。'
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
        const settings = await rendererRuntimeClient.getSettings()
        const workspaceRoot = normalizeWorkspaceRoot(settings.workspaceRoot) || '~'

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
            .filter((update): update is ResearchUpdate => Boolean(update?.text.trim()))
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

        function updateRecord(next: Partial<ResearchRecord>): void {
          persist((prev) =>
            prev.map((r) =>
              r.id === recordId
                ? { ...r, ...next, updatedAt: Date.now(), blocks: flushBlocks() }
                : r
            )
          )
        }

        let terminalEventReceived = false
        const sink: ThreadEventSink = {
          onSeq: () => {},
          onDeltas: (deltas: ThreadDeltaEvent[]) => {
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
              } else if (delta.kind === 'agent_reasoning') {
                reasoningText += delta.text
              }
            }
            if (reasoningText.trim()) {
              upsertBlock({
                kind: 'reasoning',
                id: 'reasoning',
                createdAt: new Date().toISOString(),
                text: reasoningText.trim()
              })
            }
            updateRecord({
              updates: flushUpdates(),
              summary: latestAssistantText(),
              reasoning: reasoningText.trim()
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
            updateRecord({})
          },
          onTool: (ev: ToolEventPayload) => {
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
            updateRecord({
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
            // 只有真正成功完成时才标记为 done
            updateRecord({
              status: 'done',
              updates: flushUpdates(),
              summary: latestAssistantText() || t('legalResearchNoSummary'),
              error: undefined // 清除之前的错误
            })
            setIsResearching(false)
          },
          onError: (err: Error) => {
            terminalEventReceived = true
            completeAssistantUpdates()
            updateRecord({
              status: 'error',
              error: `调研连接中断：${err.message}`,
              updates: flushUpdates(),
              summary: latestAssistantText() || t('legalResearchNoSummary')
            })
            setIsResearching(false)
          }
        }

        await provider.subscribeThreadEvents(threadId, 0, sink, signal)
        if (!signal.aborted && !terminalEventReceived) {
          updateRecord({
            status: 'error',
            error: t('legalResearchStreamEnded'),
            updates: flushUpdates(),
            summary: latestAssistantText() || t('legalResearchNoSummary')
          })
          setIsResearching(false)
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
