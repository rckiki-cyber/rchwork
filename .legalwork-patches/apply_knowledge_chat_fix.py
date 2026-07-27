from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


view = ROOT / "apps/desktop-legalwork/src/renderer/src/components/knowledge-base/KnowledgeBaseView.tsx"
file_view = ROOT / "apps/desktop-legalwork/src/renderer/src/components/knowledge-base/KnowledgeBaseFileView.tsx"

replace_once(
    view,
    "import type { ChatMessage, KnowledgeChatContext } from './knowledge-chat-history'",
    "import type { ChatMessage, KnowledgeChatContext, KnowledgeChatSource } from './knowledge-chat-history'",
    "knowledge chat type import",
)

replace_once(
    view,
    """type KnowledgeRetrievalResult = {
  contextText: string
  sources: KnowledgeRetrievalSource[]
  latencyMs: number
}

type KnowledgeClassifyResult = {""",
    """type KnowledgeRetrievalResult = {
  contextText: string
  sources: KnowledgeRetrievalSource[]
  latencyMs: number
}

type KnowledgeChatProgress = {
  reasoning: string
  text: string
}

function KnowledgeReasoning({
  text,
  streaming = false
}: {
  text: string
  streaming?: boolean
}): ReactElement | null {
  if (!text.trim()) return null
  return (
    <details
      open={streaming || undefined}
      className="mb-3 overflow-hidden rounded-[8px] border border-ds-border bg-ds-card/60"
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-[11px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)]">
        <Sparkles className="h-3.5 w-3.5 text-[var(--ds-accent)]" strokeWidth={1.8} />
        <span>思考过程</span>
        {streaming ? <span className="ml-auto text-[10px] text-[var(--ds-accent)]">实时生成</span> : null}
      </summary>
      <div className="border-t border-ds-border px-3 py-2.5 text-[12px] leading-6 text-[var(--ds-muted)]">
        <AssistantMarkdown
          text={text}
          streaming={streaming}
          className="ds-markdown ds-chat-answer break-words"
        />
      </div>
    </details>
  )
}

function KnowledgeSources({
  sources,
  onOpen
}: {
  sources: KnowledgeChatSource[]
  onOpen: (source: KnowledgeChatSource) => void
}): ReactElement | null {
  if (sources.length === 0) return null
  return (
    <div className="mt-3 border-t border-ds-border pt-3">
      <div className="mb-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-[var(--ds-muted)]">
        <span>引用来源</span>
        <span>{sources.length} 项</span>
      </div>
      <div className="space-y-1.5">
        {sources.map((source, index) => (
          <button
            key={`${source.path}-${index}`}
            type="button"
            onClick={() => onOpen(source)}
            title={source.excerpt || source.path}
            className="group flex w-full items-start gap-2 rounded-[8px] border border-ds-border bg-ds-card px-2.5 py-2 text-left transition hover:border-[color:var(--ds-accent)]/50 hover:bg-ds-hover"
          >
            <span className="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--ds-accent)]/10 px-1 text-[10px] font-semibold text-[var(--ds-accent)]">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-medium text-[var(--ds-ink)]">
                {source.citation || source.title}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--ds-muted)]">
                <span className="min-w-0 flex-1 truncate">{source.path}</span>
                {typeof source.relevanceScore === 'number' ? (
                  <span className="shrink-0">{Math.round(source.relevanceScore * 100)}%</span>
                ) : null}
                <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition group-hover:opacity-100" strokeWidth={1.8} />
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

type KnowledgeClassifyResult = {""",
    "knowledge chat presentation helpers",
)

replace_once(
    view,
    """  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [activeChatThreadId, setActiveChatThreadId] = useState<string | null>(null)
  const [chatContext, setChatContext] = useState<KnowledgeChatContext>({ kind: 'global' })
  const [chatContextThreadId, setChatContextThreadId] = useState<string | null>(null)
  const chatMessagesEndRef = useRef<HTMLDivElement>(null)""",
    """  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [activeChatThreadId, setActiveChatThreadId] = useState<string | null>(null)
  const [chatContext, setChatContext] = useState<KnowledgeChatContext>({ kind: 'global' })
  const [chatContextThreadId, setChatContextThreadId] = useState<string | null>(null)
  const [liveReasoning, setLiveReasoning] = useState('')
  const [liveAssistant, setLiveAssistant] = useState('')
  const [liveSources, setLiveSources] = useState<KnowledgeChatSource[]>([])
  const chatRequestIdRef = useRef(0)
  const chatMessagesEndRef = useRef<HTMLDivElement>(null)""",
    "knowledge chat live state",
)

replace_once(
    view,
    """        const history = knowledgeChatHistoryFromBlocks(blocks)
        setChatMessages(history.messages)
        setChatContext(history.context)
        setChatContextThreadId(threadId)""",
    """        const history = knowledgeChatHistoryFromBlocks(blocks)
        for (const message of history.messages) {
          if (!message.sourceScope || !message.sources?.length) continue
          const sourceMapping: Record<number, KnowledgeChatSource> = {}
          message.sources.forEach((source, index) => {
            sourceMapping[index + 1] = source
          })
          setKnowledgeSourceMap(sourceMapping, message.sourceScope)
        }
        setLiveReasoning('')
        setLiveAssistant('')
        setLiveSources([])
        setChatMessages(history.messages)
        setChatContext(history.context)
        setChatContextThreadId(threadId)""",
    "restore scoped sources from chat history",
)

replace_once(
    view,
    """  const pollKnowledgeChat = useCallback(async (threadId: string, maxPolls = 120): Promise<string> => {
    for (let i = 0; i < maxPolls; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const threadData = await requestJson<{
        turns: Array<{
          id: string
          status: string
          items?: Array<{
            kind: string
            text?: string
            toolName?: string
            status?: string
          }>
          error?: string
        }>
      }>(`/v1/threads/${threadId}`)
      const lastTurn = threadData.turns?.at(-1)
      if (lastTurn?.status === 'completed') {
        const reasoningItems = lastTurn.items
          ?.filter((item) => (item.kind === 'reasoning_text' || item.kind === 'assistant_reasoning') && item.text)
          .map((item) => item.text ?? '')
          .join('\n\n') || ''
        const textItems = lastTurn.items
          ?.filter((item) => item.kind === 'assistant_text' && item.text)
          .map((item) => item.text ?? '')
          .join('\n\n') || '（AI 未返回任何内容）'
        return reasoningItems
          ? `<details style="margin-bottom:8px;font-size:0.85em"><summary style="cursor:pointer;user-select:none;color:var(--ds-muted)"><span style="opacity:0.5">💭</span> 思考过程</summary>\n\n${reasoningItems}\n\n</details>\n\n${textItems}`
          : textItems
      }
      if (lastTurn?.status === 'failed') {
        throw new Error(lastTurn.error || 'AI 响应失败')
      }
      if (lastTurn?.status === 'aborted') {
        throw new Error('对话被中断')
      }
    }
    throw new Error('AI 响应超时')
  }, [])""",
    """  const pollKnowledgeChat = useCallback(async (
    threadId: string,
    onProgress: (progress: KnowledgeChatProgress) => void,
    maxPolls = 240
  ): Promise<KnowledgeChatProgress> => {
    for (let i = 0; i < maxPolls; i += 1) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 450))
      const threadData = await requestJson<{
        turns: Array<{
          id: string
          status: string
          items?: Array<{
            kind: string
            text?: string
            toolName?: string
            status?: string
          }>
          error?: string
        }>
      }>(`/v1/threads/${threadId}`)
      const lastTurn = threadData.turns?.at(-1)
      const reasoning = lastTurn?.items
        ?.filter((item) => (
          item.kind === 'reasoning_text'
          || item.kind === 'assistant_reasoning'
          || item.kind === 'agent_reasoning'
        ) && item.text)
        .map((item) => item.text ?? '')
        .join('\n\n') || ''
      const text = lastTurn?.items
        ?.filter((item) => item.kind === 'assistant_text' && item.text)
        .map((item) => item.text ?? '')
        .join('\n\n') || ''

      onProgress({ reasoning, text })

      if (lastTurn?.status === 'completed') {
        return { reasoning, text: text || '（AI 未返回任何内容）' }
      }
      if (lastTurn?.status === 'failed') {
        throw new Error(lastTurn.error || 'AI 响应失败')
      }
      if (lastTurn?.status === 'aborted') {
        throw new Error('对话被中断')
      }
    }
    throw new Error('AI 响应超时')
  }, [])""",
    "stream global knowledge chat progress",
)

replace_once(
    view,
    """  const sendKnowledgeChatMessage = useCallback(async (question: string): Promise<void> => {
    if (!question.trim() || chatSending) return
    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: question.trim(),
      timestamp: Date.now()
    }
    setChatMessages((prev) => [...prev, userMsg])
    setChatContext({ kind: 'global' })
    setChatInput('')
    setChatSending(true)
    setChatError(null)

    try {
      const retrieval = await requestJson<KnowledgeRetrievalResult>(
        `${LEGALWORK_KNOWLEDGE_RETRIEVE_PATH}?q=${encodeURIComponent(question.trim())}&max_chars=9000&exclude_expired=true`
      )

      // Save source-to-path mapping so [来源 N] links can navigate to the file.
      const sourceMapping: Record<number, { path: string; title: string }> = {}
      for (let i = 0; i < Math.min(retrieval.sources.length, 8); i += 1) {
        const s = retrieval.sources[i]
        sourceMapping[i + 1] = { path: s.path, title: s.title }
      }
      setKnowledgeSourceMap(sourceMapping)

      const context = retrieval.contextText || '（未检索到相关知识库内容）'
      const citations = retrieval.sources.length
        ? retrieval.sources
          .slice(0, 8)
          .map((source, index) => `[来源 ${index + 1}] ${source.citation || source.title}（${source.path}，相关度 ${Math.round(source.relevanceScore * 100)}%）`)
          .join('\n')
        : '无'

      const prompt = `你是一个专业的法律知识助手。请基于以下从知识库中检索到的相关内容回答用户的问题。

## RAG 检索上下文
${context}

## 可引用来源
${citations}

## 用户问题
${question.trim()}

请基于检索到的内容给出准确、专业的回答。如果内容不足以回答问题，请明确说明。引用来源时请标注对应的 [来源编号]，不要编造未出现在上下文中的依据。`

      // Reuse the active knowledge-chat thread if one exists; otherwise create a side thread.
      const workspace = await getWorkspaceRoot()
      const settings = await window.dsGui.getSettings()
      const threadModel = settings?.agents?.legalwork?.model || 'deepseek-v4-flash'
      let threadId = activeChatThreadId
      if (!threadId) {
        const threadResult = await requestJson<{ id: string }>(
          '/v1/threads',
          'POST',
          {
            workspace,
            title: knowledgeChatTitle(question.trim()),
            model: threadModel,
            mode: 'agent',
            relation: 'side'
          }
        )
        threadId = threadResult.id
        setActiveChatThreadId(threadId)
      }

      // Start a turn with the runtime's configured model
      await requestJson(`/v1/threads/${threadId}/turns`, 'POST', { prompt, model: threadModel })

      // Poll for completion
      const assistantMsg = await pollKnowledgeChat(threadId)

      // Convert [来源 N] references to clickable source://N markdown links
      const markedUp = assistantMsg.replace(
        /\[来源\s*(\d+)\]/g,
        (_match, n) => `[来源 ${n}](source://${n})`
      )

      setChatMessages((prev) => [...prev, {
        id: `ai_${Date.now()}`,
        role: 'assistant',
        content: markedUp,
        timestamp: Date.now()
      }])
      onChatThreadsChange?.()
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'AI 响应失败')
    } finally {
      setChatSending(false)
    }
  }, [chatSending, activeChatThreadId, onChatThreadsChange, pollKnowledgeChat])""",
    """  const sendKnowledgeChatMessage = useCallback(async (question: string): Promise<void> => {
    if (!question.trim() || chatSending) return
    const requestId = ++chatRequestIdRef.current
    const askedAt = Date.now()
    const sourceScope = `global_${askedAt}_${requestId}`
    const userMsg: ChatMessage = {
      id: `user_${askedAt}`,
      role: 'user',
      content: question.trim(),
      timestamp: askedAt
    }
    setChatMessages((prev) => [...prev, userMsg])
    setChatContext({ kind: 'global' })
    setChatInput('')
    setChatSending(true)
    setChatError(null)
    setLiveReasoning('')
    setLiveAssistant('')
    setLiveSources([])

    try {
      const retrieval = await requestJson<KnowledgeRetrievalResult>(
        `${LEGALWORK_KNOWLEDGE_RETRIEVE_PATH}?q=${encodeURIComponent(question.trim())}&max_chars=9000&exclude_expired=true`
      )
      if (chatRequestIdRef.current !== requestId) return

      const sources: KnowledgeChatSource[] = retrieval.sources.slice(0, 8).map((source) => ({
        path: source.path,
        title: source.title,
        citation: source.citation,
        excerpt: source.excerpt,
        relevanceScore: source.relevanceScore
      }))
      const sourceMapping: Record<number, KnowledgeChatSource> = {}
      sources.forEach((source, index) => {
        sourceMapping[index + 1] = source
      })
      setKnowledgeSourceMap(sourceMapping, sourceScope)
      setLiveSources(sources)

      const context = retrieval.contextText || '（未检索到相关知识库内容）'
      const citations = sources.length
        ? sources
          .map((source, index) => `[来源 ${index + 1}] ${source.citation || source.title}（${source.path}，相关度 ${Math.round((source.relevanceScore ?? 0) * 100)}%）`)
          .join('\n')
        : '无'

      const prompt = `你是一个专业的法律知识助手。请基于以下从知识库中检索到的相关内容回答用户的问题。

## RAG 检索上下文
${context}

## 可引用来源
${citations}

## 用户问题
${question.trim()}

请直接回答问题，并遵守以下引用规则：
1. 每个事实性判断或文件内容概括，应在对应句子末尾标注 [来源 N]；
2. 不要把所有来源集中堆在回答末尾；
3. 只引用确实支持该句内容的来源；
4. 内容不足时明确说明缺口，不得编造未出现在上下文中的依据。`

      const workspace = await getWorkspaceRoot()
      const settings = await window.dsGui.getSettings()
      const threadModel = settings?.agents?.legalwork?.model || 'deepseek-v4-flash'
      let threadId = activeChatThreadId
      if (!threadId) {
        const threadResult = await requestJson<{ id: string }>(
          '/v1/threads',
          'POST',
          {
            workspace,
            title: knowledgeChatTitle(question.trim()),
            model: threadModel,
            mode: 'agent',
            relation: 'side'
          }
        )
        threadId = threadResult.id
        setActiveChatThreadId(threadId)
      }

      await requestJson(`/v1/threads/${threadId}/turns`, 'POST', { prompt, model: threadModel })

      const assistant = await pollKnowledgeChat(threadId, (progress) => {
        if (chatRequestIdRef.current !== requestId) return
        setLiveReasoning(progress.reasoning)
        setLiveAssistant(progress.text)
      })
      if (chatRequestIdRef.current !== requestId) return

      const encodedScope = encodeURIComponent(sourceScope)
      const markedUp = assistant.text.replace(
        /\[来源\s*(\d+)\](?!\()/g,
        (_match, number: string) => `[${number}](source://${encodedScope}/${number})`
      )

      setChatMessages((prev) => [...prev, {
        id: `ai_${askedAt}`,
        role: 'assistant',
        content: markedUp,
        reasoning: assistant.reasoning || undefined,
        sources: sources.length > 0 ? sources : undefined,
        sourceScope: sources.length > 0 ? sourceScope : undefined,
        timestamp: Date.now()
      }])
      setLiveReasoning('')
      setLiveAssistant('')
      setLiveSources([])
      onChatThreadsChange?.()
    } catch (err) {
      if (chatRequestIdRef.current === requestId) {
        setChatError(err instanceof Error ? err.message : 'AI 响应失败')
      }
    } finally {
      if (chatRequestIdRef.current === requestId) {
        setChatSending(false)
      }
    }
  }, [chatSending, activeChatThreadId, onChatThreadsChange, pollKnowledgeChat])""",
    "global knowledge chat send flow",
)

replace_once(
    view,
    """  const clearChat = useCallback((): void => {
    setChatMessages([])
    setChatError(null)
    setActiveChatThreadId(null)
    setChatContext({ kind: 'global' })
    onSelectThread?.(null)
  }, [onSelectThread])""",
    """  const clearChat = useCallback((): void => {
    chatRequestIdRef.current += 1
    setChatMessages([])
    setChatError(null)
    setChatSending(false)
    setLiveReasoning('')
    setLiveAssistant('')
    setLiveSources([])
    setActiveChatThreadId(null)
    setChatContext({ kind: 'global' })
    onSelectThread?.(null)
  }, [onSelectThread])

  const openChatSource = useCallback((source: KnowledgeChatSource): void => {
    const sourceNode = findNodeByPath(tree, source.path)
    if (sourceNode) {
      openFileView(sourceNode)
      return
    }
    setChatError(`未找到引用来源“${source.title}”，文件可能已被移动、重命名或删除。`)
  }, [openFileView, tree])""",
    "clear chat and open citation source",
)

replace_once(
    view,
    """  useEffect(() => {
    chatMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])""",
    """  useEffect(() => {
    chatMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, liveAssistant, liveReasoning])""",
    "scroll live knowledge chat",
)

replace_once(
    view,
    """              {chatMessages.length > 0 ? (
                <button""",
    """              {chatMessages.length > 0 || liveAssistant || liveReasoning ? (
                <button""",
    "show clear button during live answer",
)

replace_once(
    view,
    """            {chatMessages.length === 0 && !chatSending ? (""",
    """            {chatMessages.length === 0 && !chatSending && !liveAssistant && !liveReasoning ? (""",
    "empty chat state",
)

replace_once(
    view,
    """                      {msg.role === 'assistant' ? (
                        <AssistantMarkdown
                          text={msg.content}
                          streaming={false}
                          className="ds-markdown ds-chat-answer break-words leading-relaxed"
                        />
                      ) : (
                        <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                      )}""",
    """                      {msg.role === 'assistant' ? (
                        <>
                          <KnowledgeReasoning text={msg.reasoning || ''} />
                          <AssistantMarkdown
                            text={msg.content}
                            streaming={false}
                            className="ds-markdown ds-chat-answer break-words leading-relaxed"
                          />
                          <KnowledgeSources sources={msg.sources || []} onOpen={openChatSource} />
                        </>
                      ) : (
                        <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                      )}""",
    "render structured answer content",
)

replace_once(
    view,
    """                {chatSending ? (
                  <div className="mb-4 flex justify-start">
                    <div className="max-w-[85%] rounded-[12px] border border-ds-border bg-[var(--ds-main)] px-4 py-3">
                      <div className="flex items-center gap-2 text-[13px] text-[var(--ds-muted)]">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
                        <span>AI 思考中...</span>
                      </div>
                    </div>
                  </div>
                ) : null}""",
    """                {liveReasoning || liveAssistant ? (
                  <div className="mb-4 flex justify-start">
                    <div className="max-w-[92%] rounded-[12px] border border-ds-border bg-[var(--ds-main)] px-4 py-3 text-[13px] leading-relaxed text-[var(--ds-ink)]">
                      <KnowledgeReasoning text={liveReasoning} streaming />
                      {liveAssistant ? (
                        <AssistantMarkdown
                          text={liveAssistant}
                          streaming
                          className="ds-markdown ds-chat-answer break-words leading-relaxed"
                        />
                      ) : (
                        <div className="flex items-center gap-2 text-[12px] text-[var(--ds-muted)]">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
                          <span>正在组织答案...</span>
                        </div>
                      )}
                      {liveAssistant ? <KnowledgeSources sources={liveSources} onOpen={openChatSource} /> : null}
                    </div>
                  </div>
                ) : null}

                {chatSending && !liveReasoning && !liveAssistant ? (
                  <div className="mb-4 flex justify-start">
                    <div className="max-w-[85%] rounded-[12px] border border-ds-border bg-[var(--ds-main)] px-4 py-3">
                      <div className="flex items-center gap-2 text-[13px] text-[var(--ds-muted)]">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
                        <span>正在检索知识库...</span>
                      </div>
                    </div>
                  </div>
                ) : null}""",
    "render live reasoning and answer",
)

# File-level knowledge chat already streams deltas, but its completed message was
# converted back into raw HTML. Keep reasoning as a real message and scope links.
replace_once(
    file_view,
    """      // Save source-to-path mapping so [来源 N] links can navigate to the file.
      const sourceMapping: Record<number, { path: string; title: string }> = {}
      for (let i = 0; i < Math.min(retrieval.sources.length, 8); i += 1) {
        const s = retrieval.sources[i]
        sourceMapping[i + 1] = { path: s.path, title: s.title }
      }
      setKnowledgeSourceMap(sourceMapping)""",
    """      // Keep one isolated source map per answer so older citations remain clickable.
      const sourceScope = `file_${Date.now()}`
      const sourceMapping: Record<number, { path: string; title: string }> = {}
      for (let i = 0; i < Math.min(retrieval.sources.length, 8); i += 1) {
        const s = retrieval.sources[i]
        sourceMapping[i + 1] = { path: s.path, title: s.title }
      }
      setKnowledgeSourceMap(sourceMapping, sourceScope)""",
    "scope file chat citations",
)

replace_once(
    file_view,
    """      // Convert [来源 N] references to clickable source://N markdown links
      const markedUp = (assistantMsg || streamedAssistant).replace(
        /\[来源\s*(\d+)\]/g,
        (_match, n) => `[来源 ${n}](source://${n})`
      )

      const finalReasoning = streamedReasoning.trim()
      const finalContent = markedUp || '（AI 未返回任何内容）'
      // Merge reasoning and assistant into one message, with reasoning in a collapsible section
      const mergedContent = finalReasoning
        ? `<details style="margin-bottom:8px;font-size:0.85em"><summary style="cursor:pointer;user-select:none;color:var(--ds-muted)"><span style="opacity:0.5">💭</span> 思考过程</summary>\n\n${finalReasoning}\n\n</details>\n\n${finalContent}`
        : finalContent

      setMessages((prev) => [...prev, {
        id: `ai_${Date.now()}`,
        role: 'assistant',
        content: mergedContent,
        timestamp: Date.now()
      }])""",
    """      const encodedScope = encodeURIComponent(sourceScope)
      const markedUp = (assistantMsg || streamedAssistant).replace(
        /\[来源\s*(\d+)\](?!\()/g,
        (_match, number: string) => `[${number}](source://${encodedScope}/${number})`
      )

      const finalReasoning = streamedReasoning.trim()
      const finalContent = markedUp || '（AI 未返回任何内容）'
      const completedAt = Date.now()
      setMessages((prev) => [
        ...prev,
        ...(finalReasoning ? [{
          id: `reasoning_${completedAt}`,
          role: 'reasoning' as const,
          content: finalReasoning,
          timestamp: completedAt
        }] : []),
        {
          id: `ai_${completedAt}`,
          role: 'assistant' as const,
          content: finalContent,
          timestamp: completedAt
        }
      ])""",
    "remove raw html from file chat answer",
)

print("Knowledge chat source files updated successfully.")
