import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  AudioLines,
  ExternalLink,
  File,
  FileCode2,
  Loader2,
  MessageSquare,
  PanelRightClose,
  Trash2,
  Wrench,
  X
} from 'lucide-react'
import { SendIcon } from '../icons/SendIcon'
import {
  LEGALWORK_KNOWLEDGE_EXTRACT_TEXT_PATH,
  LEGALWORK_KNOWLEDGE_READ_FILE_PATH,
  LEGALWORK_KNOWLEDGE_RETRIEVE_PATH,
  legalworkThreadTurnsPath,
  legalworkThreadTurnPath
} from '../../../../shared/legalwork-endpoints'
import { getLegalworkRuntimeSettings } from '../../../../shared/app-settings'
import { useChatStore } from '../../store/chat-store'
import { AnimatedWorkLogo } from '../chat/AnimatedWorkLogo'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import { FloatingComposerModelPicker } from '../chat/FloatingComposerModelPicker'
import { ModelBrandIcon } from '../chat/ModelBrandIcon'
import { LegalworkRuntimeProvider } from '../../agent/legalwork-runtime'
import type { ThreadEventSink } from '../../agent/types'
import { brandForModel } from '../../lib/model-brand'
import type { KnowledgeTreeNode } from './types'
import {
  findKnowledgeFileForChatContext,
  knowledgeChatHistoryFromBlocks
} from './knowledge-chat-history'
import { extractPdfTextFromBase64, PdfJsPreview } from './PdfJsPreview'
import { setKnowledgeSourceMap, setKnowledgeOpenFileHandler } from './source-map-store'

// ── Helpers (copied from KnowledgeBaseView to keep this file self-contained) ──

async function requestJson<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const result = await window.dsGui.runtimeRequest(
    path,
    method,
    body === undefined ? undefined : JSON.stringify(body)
  )
  if (!result.ok) throw new Error(result.body || `请求失败：${result.status}`)
  return JSON.parse(result.body) as T
}

/** Get the active workspace root from Electron app settings. */
async function getWorkspaceRoot(): Promise<string> {
  try {
    const settings = await window.dsGui.getSettings()
    if (settings?.workspaceRoot) return settings.workspaceRoot
  } catch {
    // fall through
  }
  return ''
}

function fileExtension(node: KnowledgeTreeNode): string {
  const raw = (node.extension ?? node.name.split('.').pop() ?? '').trim().toLowerCase()
  return raw.replace(/^\./, '').replace(/[^a-z0-9]/g, '')
}

type PreviewType = 'text' | 'markdown' | 'pdf' | 'image' | 'audio' | 'document' | 'unsupported'

function previewType(node: KnowledgeTreeNode): PreviewType {
  const ext = fileExtension(node)
  if (ext === 'pdf') return 'pdf'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image'
  if (['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg'].includes(ext)) return 'audio'
  if (['md', 'markdown'].includes(ext)) return 'markdown'
  if (['txt', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'html', 'xml'].includes(ext)) return 'text'
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'document'
  return 'unsupported'
}

function mimeTypeForFile(node: KnowledgeTreeNode): string {
  const ext = fileExtension(node)
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    aac: 'audio/aac',
    flac: 'audio/flac',
    ogg: 'audio/ogg'
  }
  return map[ext] || 'application/octet-stream'
}

function buildObjectUrl(node: KnowledgeTreeNode, base64Content: string): string {
  const byteString = atob(base64Content)
  const bytes = new Uint8Array(byteString.length)
  for (let i = 0; i < byteString.length; i += 1) {
    bytes[i] = byteString.charCodeAt(i)
  }
  const blob = new Blob([bytes], { type: mimeTypeForFile(node) })
  return URL.createObjectURL(blob)
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

function fileTypeLabel(node: KnowledgeTreeNode): string {
  if (node.kind === 'folder') return '文件夹'
  const ext = fileExtension(node)
  if (!ext) return '文件'
  if (ext === 'doc' || ext === 'docx') return 'WORD'
  if (ext === 'ppt' || ext === 'pptx') return 'PPT'
  if (ext === 'xls' || ext === 'xlsx') return 'EXCEL'
  if (ext === 'pdf') return 'PDF'
  if (['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg'].includes(ext)) return '音频'
  if (['zip', 'rar', '7z'].includes(ext)) return '压缩包'
  return ext.toUpperCase()
}

// ── Chat message types ──

type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'reasoning' | 'tool'
  content: string
  timestamp: number
  status?: string
}

type KnowledgeToolMessageInput = {
  itemId: string
  status?: string
  summary?: string
  toolKind?: string
}

type FileContent = {
  content: string
  encoding: 'utf8' | 'base64'
  objectUrl?: string
  type: PreviewType
  extractedText?: string
}

function knowledgeFileChatTitle(fileName: string, question: string): string {
  const trimmed = question.trim()
  const summary = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed
  return `知识库：${fileName} · ${summary}`
}

function currentFileTextForPrompt(fileContent: FileContent | null): string {
  const directText = fileContent?.extractedText?.trim()
    || (fileContent?.encoding === 'utf8' ? fileContent.content.trim() : '')
  return directText.slice(0, 16000)
}

// ── Document text extraction preview component ──

function DocumentPreview({ text, fileName }: { text: string; fileName: string }): ReactElement {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-ds-border bg-ds-card px-4 py-2 text-[12px] text-[var(--ds-muted)]">
        文档文本预览 · {fileName}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {text ? (
          <pre className="whitespace-pre-wrap font-sans text-[13px] leading-[22px] text-[var(--ds-ink)]">
            {text}
          </pre>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-[13px] text-[var(--ds-muted)]">
            <File className="h-10 w-10 text-slate-300" strokeWidth={1.4} />
            <div>未能提取到可预览文本</div>
            <div className="text-[12px]">你可以通过右侧 AI 对话功能提问文件相关问题。</div>
          </div>
        )}
      </div>
    </div>
  )
}

type KnowledgeRetrievalSource = {
  path: string
  title: string
  relevanceScore: number
  citation: string
}

type KnowledgeRetrievalResult = {
  contextText: string
  sources: KnowledgeRetrievalSource[]
  latencyMs: number
}

const knowledgeRuntimeProvider = new LegalworkRuntimeProvider()

// ── Main component ──

type Props = {
  node: KnowledgeTreeNode
  onBack: () => void
  selectedThreadId?: string | null
  onSelectThread?: (id: string | null) => void
  onChatThreadsChange?: () => void
}

export function KnowledgeBaseFileView({
  node,
  onBack,
  selectedThreadId,
  onSelectThread,
  onChatThreadsChange
}: Props): ReactElement {
  const [fileContent, setFileContent] = useState<FileContent | null>(null)
  const [fileLoading, setFileLoading] = useState(true)
  const [fileError, setFileError] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [activeChatThreadId, setActiveChatThreadId] = useState<string | null>(null)
  const [liveReasoning, setLiveReasoning] = useState('')
  const [liveAssistant, setLiveAssistant] = useState('')
  const [runtimeModel, setRuntimeModel] = useState('')
  const [chatOpen, setChatOpen] = useState(true)
  const [chatWidth, setChatWidth] = useState(360)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatAbortRef = useRef<AbortController | null>(null)
  const resizingChatRef = useRef(false)
  const splitContainerRef = useRef<HTMLDivElement>(null)

  const MIN_CHAT_WIDTH = 320
  const MAX_CHAT_WIDTH = 520
  const MIN_PREVIEW_WIDTH = 720

  const startChatResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    resizingChatRef.current = true
    const startX = event.clientX
    const startWidth = chatWidth
    const onMove = (ev: PointerEvent): void => {
      if (!resizingChatRef.current) return
      const delta = startX - ev.clientX
      const containerWidth = splitContainerRef.current?.clientWidth ?? window.innerWidth
      const maxWidthWithPreview = Math.max(MIN_CHAT_WIDTH, containerWidth - MIN_PREVIEW_WIDTH)
      const nextMax = Math.min(MAX_CHAT_WIDTH, maxWidthWithPreview)
      const next = Math.max(MIN_CHAT_WIDTH, Math.min(nextMax, startWidth + delta))
      setChatWidth(next)
    }
    const onUp = (): void => {
      resizingChatRef.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [chatWidth])

  const toggleChat = useCallback((): void => {
    setChatOpen((prev) => !prev)
  }, [])

  // Load file content on mount
  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      setFileLoading(true)
      setFileError(null)
      try {
        const type = previewType(node)
        // For unsupported binary types, try to read as base64 and extract what we can
        if (type === 'unsupported') {
          // Try reading as base64 to at least show file info
          try {
            const data = await requestJson<{ path: string; content: string; encoding: 'utf8' | 'base64' }>(
              `${LEGALWORK_KNOWLEDGE_READ_FILE_PATH}?path=${encodeURIComponent(node.path)}&encoding=base64`
            )
            if (cancelled) return
            const objectUrl = buildObjectUrl(node, data.content)
            setFileContent({ content: data.content, encoding: 'base64', objectUrl, type: 'unsupported' })
          } catch {
            // If even binary read fails, just set empty content
            if (!cancelled) setFileContent({ content: '', encoding: 'utf8', type: 'unsupported' })
          }
          return
        }
        if (type === 'pdf') {
          const data = await requestJson<{ path: string; content: string; encoding: 'utf8' | 'base64' }>(
            `${LEGALWORK_KNOWLEDGE_READ_FILE_PATH}?path=${encodeURIComponent(node.path)}&encoding=base64`
          )
          const extracted = await requestJson<{ path: string; text: string; extension: string }>(
            `${LEGALWORK_KNOWLEDGE_EXTRACT_TEXT_PATH}?path=${encodeURIComponent(node.path)}`
          ).catch(() => null)
          if (cancelled) return
          let extractedText = extracted?.text?.trim() ?? ''
          if (!extractedText && data.content) {
            extractedText = await extractPdfTextFromBase64(data.content).catch(() => '')
            if (cancelled) return
          }
          let objectUrl: string | undefined
          if (data.content) {
            try {
              objectUrl = buildObjectUrl(node, data.content)
            } catch {
              objectUrl = undefined
            }
          }
          setFileContent({
            content: data.content,
            encoding: data.encoding,
            objectUrl,
            type,
            extractedText
          })
          return
        }
        if (type === 'document') {
          // Extract plain text from pdf/docx/xlsx via the runtime
          try {
            const data = await requestJson<{ path: string; text: string; extension: string }>(
              `${LEGALWORK_KNOWLEDGE_EXTRACT_TEXT_PATH}?path=${encodeURIComponent(node.path)}`
            )
            if (cancelled) return
            setFileContent({ content: data.text, encoding: 'utf8', type: 'document' })
          } catch {
            if (!cancelled) setFileContent({ content: '', encoding: 'utf8', type: 'document' })
          }
          return
        }
        const isBinary = type === 'image' || type === 'audio'
        const data = await requestJson<{ path: string; content: string; encoding: 'utf8' | 'base64' }>(
          `${LEGALWORK_KNOWLEDGE_READ_FILE_PATH}?path=${encodeURIComponent(node.path)}${isBinary ? '&encoding=base64' : ''}`
        )
        if (cancelled) return
        let objectUrl: string | undefined
        if (isBinary && data.content) {
          try {
            objectUrl = buildObjectUrl(node, data.content)
          } catch {
            // buildObjectUrl can fail on invalid base64; for PDF the
            // PdfPreview component uses raw base64Content directly anyway
          }
        }
        setFileContent({ content: data.content, encoding: data.encoding, objectUrl, type })
      } catch (err) {
        if (!cancelled) setFileError(err instanceof Error ? err.message : '读取文件失败')
      } finally {
        if (!cancelled) setFileLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [node])

  // Auto-scroll chat to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, liveAssistant, liveReasoning])

  // Cleanup object URL on unmount or when the URL changes
  useEffect(() => {
    const objectUrl = fileContent?.objectUrl
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [fileContent])

  useEffect(() => {
    return () => chatAbortRef.current?.abort()
  }, [])

  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([])
      setActiveChatThreadId(null)
      setChatError(null)
      return
    }
    const threadId = selectedThreadId
    let cancelled = false
    async function loadChatHistory(): Promise<void> {
      setChatError(null)
      setMessages([])
      setActiveChatThreadId(null)
      try {
        const { blocks } = await knowledgeRuntimeProvider.getThreadDetail(threadId)
        if (cancelled) return
        const history = knowledgeChatHistoryFromBlocks(blocks)
        const linkedFile = findKnowledgeFileForChatContext([node], history.context)
        if (!linkedFile) {
          setChatError('这条对话与当前文件不匹配，请从左侧记录重新打开。')
          return
        }
        setMessages(history.messages)
        setActiveChatThreadId(threadId)
        setChatOpen(true)
      } catch (err) {
        if (!cancelled) {
          setChatError(err instanceof Error ? err.message : '加载对话记录失败')
        }
      }
    }
    void loadChatHistory()
    return () => {
      cancelled = true
    }
  }, [node, selectedThreadId])

  const openInSystemApp = useCallback(async (): Promise<void> => {
    try {
      const result = await window.dsGui.openKnowledgeFile(node.path)
      if (!result.ok) setChatError(result.message || '打开文件失败')
    } catch (err) {
      setChatError(err instanceof Error ? err.message : '打开文件失败')
    }
  }, [node.path])

  // ── AI Chat: RAG-based Q&A ──
  const composerModel = useChatStore((s) => s.composerModel)
  const composerPickList = useChatStore((s) => s.composerPickList)
  const composerModelGroups = useChatStore((s) => s.composerModelGroups)
  const setComposerModel = useChatStore((s) => s.setComposerModel)
  const loadComposerModels = useChatStore((s) => s.loadComposerModels)
  const activeModel = composerModel.trim() || 'auto'
  const effectiveModel =
    activeModel && activeModel !== 'auto'
      ? activeModel
      : runtimeModel.trim() || activeModel
  const modelBrand = brandForModel(effectiveModel, composerModelGroups)

  useEffect(() => {
    void loadComposerModels()
  }, [loadComposerModels])

  useEffect(() => {
    let cancelled = false
    void window.dsGui.getSettings().then((settings) => {
      if (cancelled) return
      setRuntimeModel(getLegalworkRuntimeSettings(settings).model)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  const pushOrUpdateToolMessage = useCallback((tool: KnowledgeToolMessageInput): void => {
    const id = `tool_${tool.itemId}`
    setMessages((prev) => {
      const content = tool.summary || tool.toolKind || '工具调用'
      const existingIndex = prev.findIndex((msg) => msg.id === id)
      if (existingIndex < 0) {
        return [...prev, {
          id,
          role: 'tool',
          content,
          status: tool.status,
          timestamp: Date.now()
        }]
      }
      const next = [...prev]
      next[existingIndex] = {
        ...next[existingIndex],
        content,
        status: tool.status,
        timestamp: Date.now()
      }
      return next
    })
  }, [])

  // Poll for turn completion
  const pollTurnCompletion = useCallback(async (threadId: string, turnId: string, maxPolls = 120): Promise<string> => {
    for (let i = 0; i < maxPolls; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))

      const turnData = await requestJson<{
        id: string
        status: string
        items?: Array<{
          kind: string
          text?: string
          toolName?: string
          status?: string
        }>
        error?: string
      }>(legalworkThreadTurnPath(threadId, turnId))

      if (turnData.status === 'completed') {
        // Extract the assistant's text response from items
        const textItems = turnData.items
          ?.filter((item) => item.kind === 'assistant_text' && item.text)
          .map((item) => item.text ?? '')
          .join('\n\n') || '（AI 未返回任何内容）'
        return textItems
      }

      if (turnData.status === 'failed') {
        throw new Error(turnData.error || 'AI 响应失败')
      }

      if (turnData.status === 'aborted') {
        throw new Error('对话被中断')
      }

      // For 'queued' or 'running', continue polling
    }
    throw new Error('AI 响应超时')
  }, [])

  const sendMessage = useCallback(async (question: string): Promise<void> => {
    if (!question.trim() || sending) return
    chatAbortRef.current?.abort()
    const abort = new AbortController()
    chatAbortRef.current = abort
    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: question.trim(),
      timestamp: Date.now()
    }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setSending(true)
    setChatError(null)
    setLiveReasoning('')
    setLiveAssistant('')

    try {
      const retrievalQuery = `${question.trim()} ${node.name} ${node.path}`
      const retrieval = await requestJson<KnowledgeRetrievalResult>(
        `${LEGALWORK_KNOWLEDGE_RETRIEVE_PATH}?q=${encodeURIComponent(retrievalQuery)}&max_chars=9000&exclude_expired=true`
      ).catch((): KnowledgeRetrievalResult => ({
        contextText: '',
        sources: [],
        latencyMs: 0
      }))

      // Save source-to-path mapping so [来源 N] links can navigate to the file.
      const sourceMapping: Record<number, { path: string; title: string }> = {}
      for (let i = 0; i < Math.min(retrieval.sources.length, 8); i += 1) {
        const s = retrieval.sources[i]
        sourceMapping[i + 1] = { path: s.path, title: s.title }
      }
      setKnowledgeSourceMap(sourceMapping)

      const currentFileText = currentFileTextForPrompt(fileContent)
      const currentFileContext = currentFileText
        ? `## 当前打开文件的正文（优先依据）\n${currentFileText}`
        : `## 当前打开文件\n${node.name}（${fileTypeLabel(node)}，${formatBytes(node.sizeBytes)}）\n\n未能从当前文件直接提取到可用正文。`
      const retrievalContext = retrieval.contextText
        ? `## 知识库补充检索结果（仅作补充，不得替代当前文件）\n${retrieval.contextText}`
        : '## 知识库补充检索结果\n无'
      const citations = retrieval.sources.length
        ? retrieval.sources
          .slice(0, 8)
          .map((source, index) => `[来源 ${index + 1}] ${source.citation || source.title}（${source.path}，相关度 ${Math.round(source.relevanceScore * 100)}%）`)
          .join('\n')
        : '无'

      const prompt = `你是一个专业的法律知识助手。请基于以下检索到的相关内容回答用户的问题。

## 当前文件
${node.name}（${fileTypeLabel(node)}）

## 当前文件路径
${node.path}

${currentFileContext}

${retrievalContext}

## 可引用来源
当前文件：${node.name}（来自文件预览页直接读取）
${citations}

## 用户问题
${question.trim()}

请优先依据“当前打开文件的正文”回答；知识库补充检索结果只能用于交叉参考或补充背景，不能把其他文件内容误认为当前文件内容。如果当前文件正文不足以回答问题，请明确说明缺口。引用补充来源时请标注对应的 [来源编号]，不要编造未出现在上下文中的依据。`

      // Step 4: Reuse the active file-chat thread or create a side thread so it does not sync to the main chat sidebar.
      const workspace = await getWorkspaceRoot()
      let threadId = activeChatThreadId
      if (!threadId) {
        const threadResult = await requestJson<{ id: string }>(
          '/v1/threads',
          'POST',
          {
            workspace,
            title: knowledgeFileChatTitle(node.name, question.trim()),
            model: effectiveModel,
            mode: 'agent',
            relation: 'side'
          }
        )
        threadId = threadResult.id
        setActiveChatThreadId(threadId)
      }

      // Step 5: Start a turn with the runtime's configured model
      const turnResponse = await requestJson<{ turnId: string }>(
        legalworkThreadTurnsPath(threadId),
        'POST',
        { prompt, model: effectiveModel }
      )
      const turnId = turnResponse.turnId

      let streamedAssistant = ''
      let streamedReasoning = ''
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (error?: Error): void => {
          if (settled) return
          settled = true
          if (!abort.signal.aborted) abort.abort()
          if (error) reject(error)
          else resolve()
        }
        const sink: ThreadEventSink = {
          onSeq: () => undefined,
          onDeltas: (deltas) => {
            for (const delta of deltas) {
              if (delta.kind === 'agent_reasoning') {
                streamedReasoning += delta.text
                setLiveReasoning(streamedReasoning)
              } else {
                streamedAssistant += delta.text
                setLiveAssistant(streamedAssistant)
              }
            }
          },
          onUserMessage: () => undefined,
          onTool: pushOrUpdateToolMessage,
          onCompaction: (ev) => {
            pushOrUpdateToolMessage({
              itemId: ev.itemId,
              status: ev.status,
              summary: ev.summary
            })
          },
          onApproval: (req) => {
            pushOrUpdateToolMessage({
              itemId: req.approvalId,
              status: 'running',
              summary: req.summary
            })
          },
          onUserInput: (req) => {
            pushOrUpdateToolMessage({
              itemId: req.requestId,
              status: 'running',
              summary: req.questions.map((q) => q.question).join(' · ') || '等待用户输入'
            })
          },
          onUserInputStatus: (ev) => {
            pushOrUpdateToolMessage({
              itemId: ev.itemId,
              status: ev.status === 'submitted' ? 'success' : 'error',
              summary: ev.status === 'submitted' ? '用户输入已提交' : '用户输入已取消'
            })
          },
          onGoal: () => undefined,
          onTodos: () => undefined,
          onTurnComplete: () => settle(),
          onError: (err) => settle(err)
        }
        void knowledgeRuntimeProvider.subscribeThreadEvents(threadId, 0, sink, abort.signal).then(
          () => settle(),
          (error: unknown) => settle(error instanceof Error ? error : new Error(String(error)))
        )
      })

      // Step 6: Poll for completion (poll the specific turn, not the whole thread)
      // after SSE closes so final persisted text can fill any missed early deltas.
      const assistantMsg = await pollTurnCompletion(threadId, turnId)

      // Convert [来源 N] references to clickable source://N markdown links
      const markedUp = (assistantMsg || streamedAssistant).replace(
        /\[来源\s*(\d+)\]/g,
        (_match, n) => `[来源 ${n}](source://${n})`
      )

      const finalReasoning = streamedReasoning.trim()
      if (finalReasoning) {
        setMessages((prev) => [...prev, {
          id: `reasoning_${Date.now()}`,
          role: 'reasoning',
          content: streamedReasoning,
          timestamp: Date.now()
        }])
      }

      setMessages((prev) => [...prev, {
        id: `ai_${Date.now()}`,
        role: 'assistant',
        content: markedUp || '（AI 未返回任何内容）',
        timestamp: Date.now()
      }])
      setLiveReasoning('')
      setLiveAssistant('')
      onChatThreadsChange?.()
    } catch (err) {
      if (chatAbortRef.current === abort) {
        setChatError(err instanceof Error ? err.message : 'AI 响应失败')
      }
    } finally {
      if (chatAbortRef.current === abort) chatAbortRef.current = null
      setSending(false)
    }
  }, [effectiveModel, fileContent, node, pollTurnCompletion, pushOrUpdateToolMessage, sending, activeChatThreadId, onChatThreadsChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage(input)
    }
  }, [input, sendMessage])

  const clearChat = useCallback((): void => {
    chatAbortRef.current?.abort()
    chatAbortRef.current = null
    setMessages([])
    setChatError(null)
    setLiveReasoning('')
    setLiveAssistant('')
    setSending(false)
    setActiveChatThreadId(null)
    onSelectThread?.(null)
  }, [onSelectThread])

  // ── Render ──

  return (
    <div className="ds-no-drag flex h-full min-h-0 flex-col bg-[var(--ds-main)]">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-ds-border px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[var(--ds-muted)] transition hover:bg-ds-hover hover:text-[var(--ds-ink)]"
            title="返回文件列表"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
          </button>
          <FileCode2 className="h-5 w-5 text-[var(--ds-accent)]" strokeWidth={1.7} />
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-[var(--ds-ink)]">{node.name}</h2>
            <p className="text-[12px] text-[var(--ds-muted)]">
              {fileTypeLabel(node)} · {formatBytes(node.sizeBytes)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleChat}
            className={`inline-flex h-8 items-center gap-1.5 rounded-[6px] border px-3 text-[12px] font-medium transition ${
              chatOpen
                ? 'border-[var(--ds-accent)] bg-[var(--ds-accent)]/10 text-[var(--ds-accent)]'
                : 'border-ds-border bg-ds-card text-[var(--ds-muted)] hover:bg-ds-hover hover:text-[var(--ds-ink)]'
            }`}
            title={chatOpen ? '收起 AI 对话' : '展开 AI 对话'}
          >
            {chatOpen ? (
              <PanelRightClose className="h-3.5 w-3.5" strokeWidth={1.8} />
            ) : (
              <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.8} />
            )}
            <span>AI 对话</span>
          </button>
          <button
            type="button"
            onClick={() => void openInSystemApp()}
            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-ds-border bg-ds-card px-3 text-[12px] font-medium text-[var(--ds-muted)] transition hover:bg-ds-hover hover:text-[var(--ds-ink)]"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span>系统打开</span>
          </button>
        </div>
      </header>

      {/* Content + Chat split */}
      <div ref={splitContainerRef} className="flex min-h-0 flex-1">
        {/* File Content Panel */}
        <div className={`flex min-w-[min(720px,100%)] flex-1 flex-col ${chatOpen ? 'border-r border-ds-border' : ''}`}>
          {fileLoading ? (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-[var(--ds-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
              正在读取...
            </div>
          ) : fileError ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
              <div className="text-[13px] text-red-500">{fileError}</div>
              <button
                type="button"
                onClick={() => void openInSystemApp()}
                className="inline-flex items-center gap-1.5 rounded-[8px] border border-ds-border bg-ds-card px-4 py-2 text-[12px] font-medium text-[var(--ds-muted)] transition hover:bg-ds-hover hover:text-[var(--ds-ink)]"
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
                <span>系统打开</span>
              </button>
            </div>
          ) : !fileContent ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-[var(--ds-muted)]">
              <File className="h-10 w-10 text-slate-300" strokeWidth={1.4} />
              <div>无法加载文件内容</div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              {fileContent.type === 'pdf' ? (
                <PdfJsPreview
                  base64Content={fileContent.content}
                  fileName={node.name}
                />
              ) : fileContent.type === 'image' && fileContent.objectUrl ? (
                <div className="flex h-full items-center justify-center p-4">
                  <img
                    src={fileContent.objectUrl}
                    alt={node.name}
                    className="h-auto max-h-full w-full object-contain"
                  />
                </div>
              ) : fileContent.type === 'audio' && fileContent.objectUrl ? (
                <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
                  <AudioLines className="h-12 w-12 text-[var(--ds-accent)]" strokeWidth={1.5} />
                  <audio src={fileContent.objectUrl} controls className="w-full max-w-md" />
                  <div className="text-[12px] text-[var(--ds-muted)]">{node.name}</div>
                </div>
              ) : fileContent.type === 'document' ? (
                <DocumentPreview text={fileContent.content} fileName={node.name} />
              ) : fileContent.type === 'markdown' ? (
                <AssistantMarkdown
                  text={fileContent.content}
                  streaming={false}
                  className="ds-markdown ds-chat-answer break-words px-6 py-5 text-[14px] leading-7 text-[var(--ds-ink)]"
                />
              ) : fileContent.type === 'text' ? (
                <pre className="whitespace-pre-wrap p-6 font-mono text-[13px] leading-[22px] text-[var(--ds-ink)]">
                  {fileContent.content}
                </pre>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
                  <File className="h-10 w-10 text-slate-300" strokeWidth={1.4} />
                  <div className="text-[13px] font-medium text-[var(--ds-ink)]">
                    {fileTypeLabel(node)} 文件
                  </div>
                  <p className="max-w-xs text-[12px] leading-relaxed text-[var(--ds-muted)]">
                    此文件类型暂不支持内联预览，{chatOpen ? '但你可以通过右侧 AI 对话功能提问文件相关问题。' : '你可以展开右侧 AI 对话提问文件相关问题。'}
                  </p>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--ds-muted)]">
                    <span>{formatBytes(node.sizeBytes)}</span>
                    <span className="text-ds-border">·</span>
                    <span>{fileTypeLabel(node)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openInSystemApp()}
                    className="inline-flex items-center gap-1.5 rounded-[8px] border border-ds-border bg-ds-card px-4 py-2 text-[12px] font-medium text-[var(--ds-muted)] transition hover:bg-ds-hover hover:text-[var(--ds-ink)]"
                  >
                    <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
                    <span>系统打开</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* AI Chat Panel */}
        {chatOpen ? (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              className="relative z-20 shrink-0 cursor-col-resize bg-ds-border hover:bg-[var(--ds-accent)] w-[3px] transition-colors"
              onPointerDown={startChatResize}
            />
            <aside
              className="flex h-full min-w-0 flex-col border-l border-ds-border bg-ds-card"
              style={{ width: chatWidth }}
            >
          <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-ds-border px-4 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <ModelBrandIcon brand={modelBrand} className="h-5 w-5" />
              <span className="text-[13px] font-medium text-[var(--ds-ink)]">AI 对话</span>
            </div>
            <div className="flex min-w-0 shrink-0 items-center gap-1.5">
              <FloatingComposerModelPicker
                compact
                mode="combobox"
                composerModel={effectiveModel}
                composerPickList={composerPickList}
                composerModelGroups={composerModelGroups}
                canChangeModel={!sending}
                onComposerModelChange={setComposerModel}
              />
              {messages.length > 0 || liveAssistant || liveReasoning ? (
                <button
                  type="button"
                  onClick={clearChat}
                  className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--ds-muted)] transition hover:bg-ds-hover hover:text-[var(--ds-ink)]"
                  title="清空对话"
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              ) : null}
            </div>
          </div>

          {messages.length === 0 && !sending && !liveAssistant && !liveReasoning ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <AnimatedWorkLogo active brand={modelBrand} phase="lead" size="md" />
              <div className="text-[13px] font-medium text-[var(--ds-ink)]">关于此文件提问</div>
              <p className="text-[12px] leading-relaxed text-[var(--ds-muted)]">
                基于当前文件内容进行 AI 对话。你可以询问文件中的关键信息、法律条款分析或内容总结。
              </p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`mb-4 flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {msg.role !== 'user' ? (
                    <div className="mr-2 mt-1 shrink-0">
                      {msg.role === 'tool' ? (
                        <Wrench className="h-5 w-5 text-[var(--ds-muted)]" strokeWidth={1.7} />
                      ) : (
                        <ModelBrandIcon brand={modelBrand} className="h-5 w-5" />
                      )}
                    </div>
                  ) : null}
                  <div
                    className={`max-w-[85%] rounded-[12px] px-4 py-2.5 text-[13px] leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-[var(--ds-accent)] text-white'
                        : msg.role === 'reasoning'
                          ? 'border border-ds-border bg-ds-card/70 text-[var(--ds-muted)]'
                          : msg.role === 'tool'
                            ? 'border border-ds-border bg-ds-card/70 text-[var(--ds-muted)]'
                        : 'border border-ds-border bg-[var(--ds-main)] text-[var(--ds-ink)]'
                    }`}
                  >
                    {msg.role === 'assistant' || msg.role === 'reasoning' ? (
                      <AssistantMarkdown
                        text={msg.content}
                        streaming={false}
                        className="ds-markdown ds-chat-answer break-words"
                      />
                    ) : msg.role === 'tool' ? (
                      <div className="flex items-center gap-2">
                        {msg.status === 'running' ? (
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" strokeWidth={1.8} />
                        ) : null}
                        <span className="min-w-0 flex-1 break-words">{msg.content}</span>
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                    )}
                    <div
                      className={`mt-1 text-[10px] ${
                        msg.role === 'user' ? 'text-white/60' : 'text-[var(--ds-muted)]'
                      }`}
                    >
                      {new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </div>
                  </div>
                </div>
              ))}

              {liveReasoning ? (
                <div className="mb-4 flex justify-start">
                  <div className="mr-2 mt-1 shrink-0">
                    <AnimatedWorkLogo active brand={modelBrand} phase="trail" size="sm" />
                  </div>
                  <div className="max-w-[85%] rounded-[12px] border border-ds-border bg-ds-card/70 px-4 py-2.5 text-[13px] leading-relaxed text-[var(--ds-muted)]">
                    <AssistantMarkdown
                      text={liveReasoning}
                      streaming
                      className="ds-markdown ds-chat-answer break-words"
                    />
                  </div>
                </div>
              ) : null}

              {liveAssistant ? (
                <div className="mb-4 flex justify-start">
                  <div className="mr-2 mt-1 shrink-0">
                    <ModelBrandIcon brand={modelBrand} className="h-5 w-5" />
                  </div>
                  <div className="max-w-[85%] rounded-[12px] border border-ds-border bg-[var(--ds-main)] px-4 py-2.5 text-[13px] leading-relaxed text-[var(--ds-ink)]">
                    <AssistantMarkdown
                      text={liveAssistant}
                      streaming
                      className="ds-markdown ds-chat-answer break-words"
                    />
                  </div>
                </div>
              ) : null}

              {sending ? (
                <div className="mb-4 flex justify-start">
                  <div className="mr-2 mt-1 shrink-0">
                    <AnimatedWorkLogo active brand={modelBrand} phase="trail" size="sm" />
                  </div>
                  <div className="max-w-[85%] rounded-[12px] border border-ds-border bg-[var(--ds-main)] px-4 py-3">
                    <div className="flex items-center gap-2 text-[13px] text-[var(--ds-muted)]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
                      <span>AI 思考中...</span>
                    </div>
                  </div>
                </div>
              ) : null}

              {chatError ? (
                <div className="mb-4 rounded-[8px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-600 dark:border-red-900/50 dark:bg-red-950/20">
                  {chatError}
                </div>
              ) : null}

              <div ref={messagesEndRef} />
            </div>
          )}

          <div className="shrink-0 border-t border-ds-border p-3">
            <div className="flex items-center gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入关于文件的问题..."
                disabled={sending}
                className="h-10 flex-1 rounded-[8px] border border-ds-border bg-[var(--ds-main)] px-3 text-[13px] text-[var(--ds-ink)] outline-none transition focus:border-[var(--ds-accent)] disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void sendMessage(input)}
                disabled={sending || !input.trim()}
                className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-[var(--ds-accent)] text-white transition hover:opacity-90 disabled:opacity-50"
              >
                <SendIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </aside>
          </>
        ) : null}
      </div>
    </div>
  )
}
