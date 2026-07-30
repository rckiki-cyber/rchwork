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

export interface ResearchRecord {
  id: string
  query: string
  timestamp: string
  updatedAt?: number
  status: 'running' | 'done' | 'error'
  blocks: ChatBlock[]
  steps: ResearchStep[]
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
      ? parsed.map((record) => ({ ...record, blocks: record.blocks ?? [] }))
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
          '请对以下法律问题进行多源调研：「{{query}}」。\n\n【重要要求】\n1. 你的所有思考过程、推理分析必须使用中文，不要使用英文。\n2. 主动调用可用的 skill 和 MCP 工具（如多引擎搜索、类案检索、学术文献、法规提取、网页内容抓取等）。\n3. 收集网络信息、裁判案例、学术文献、现行法规与权威解读。\n4. 如果检索工具提供原文链接，必须保留工具返回的完整 URL，不得自行拼接或猜测；引用国家法律法规数据库时，优先调用 `knowledge_legal_external_sources`，只使用该工具本次返回且经详情接口核验的 `records.path`（应为 `https://flk.npc.gov.cn/detail?id=...`），不得引用会打开数据库首页的 `https://flk.npc.gov.cn/index?...`。没有核验通过的详情记录时，改引官方公报 PDF、全国人大官网等权威页面，或明确标注无可核验链接。国家法律法规数据库检索/详情/下载接口可用时，不要把普通的前端页面抓取不完整概括为“反爬限制”；只有工具明确返回 403、验证码、WAF 或访问限制证据时，才说明访问受限。北大法宝 doc-link/链接增强工具可用时，使用它补全法规与案例的原文链接。\n5. 最终总结使用 Markdown 输出：如果链接前的文字已经写清楚法规名称、法条标题、案例名称、案号或网页标题，链接文本可简写为 `[国家法律法规数据库链接](完整URL)`、`[北大法宝链接](完整URL)`、`[原文链接](完整URL)`；如果前文没有说明标题，链接文本必须使用清楚的页面标题或资料名称。没有真实 URL 时只写名称并明确标注“无可核验链接”，不得生成虚假链接。\n6. 最后给出结构化的综合总结。\n7. 推理过程要简洁，只列出关键行动步骤，不要展开长篇大论。\n8. 【容错原则】如果某个工具调用失败或返回错误，不要停止，立即尝试其他工具或替代方法完成调研。一个途径不行就换另一个，确保最终给出完整结果。'
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

        let assistantText = ''
        let reasoningText = ''
        const toolSteps = new Map<string, ResearchStep>()
        const blockMap = new Map<string, ChatBlock>()

        function upsertBlock(block: ChatBlock): void {
          blockMap.set(block.id, block)
        }

        function flushBlocks(): ChatBlock[] {
          return [...blockMap.values()]
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
                assistantText += delta.text
              } else if (delta.kind === 'agent_reasoning') {
                reasoningText += delta.text
              }
            }
            if (assistantText.trim()) {
              upsertBlock({
                kind: 'assistant',
                id: 'assistant',
                createdAt: new Date().toISOString(),
                text: assistantText.trim()
              })
            }
            if (reasoningText.trim()) {
              upsertBlock({
                kind: 'reasoning',
                id: 'reasoning',
                createdAt: new Date().toISOString(),
                text: reasoningText.trim()
              })
            }
            updateRecord({ summary: assistantText.trim(), reasoning: reasoningText.trim() })
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
            updateRecord({})
          },
          onCompaction: () => {},
          onApproval: () => {},
          onUserInput: () => {},
          onUserInputStatus: () => {},
          onGoal: () => {},
          onTurnComplete: () => {
            terminalEventReceived = true
            // 只有真正成功完成时才标记为 done
            updateRecord({
              status: 'done',
              summary: assistantText.trim() || t('legalResearchNoSummary'),
              error: undefined // 清除之前的错误
            })
            setIsResearching(false)
          },
          onError: (err: Error) => {
            terminalEventReceived = true
            updateRecord({
              status: 'error',
              error: `调研连接中断：${err.message}`,
              summary: assistantText.trim() || t('legalResearchNoSummary')
            })
            setIsResearching(false)
          }
        }

        await provider.subscribeThreadEvents(threadId, 0, sink, signal)
        if (!signal.aborted && !terminalEventReceived) {
          updateRecord({
            status: 'error',
            error: t('legalResearchStreamEnded'),
            summary: assistantText.trim() || t('legalResearchNoSummary')
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
