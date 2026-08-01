import type { TurnItem } from '../../contracts/items.js'
import type {
  ModelClient,
  ModelInputAttachment,
  ModelRequest,
  ModelStreamChunk,
  ModelTextAttachmentFallback
} from '../../ports/model-client.js'
import {
  CodexAppServerRpc,
  type CodexServerRequest
} from './codex-app-server-rpc.js'

type JsonObject = Record<string, unknown>

type QueueWaiter<T> = {
  resolve: (value: IteratorResult<T>) => void
  reject: (error: Error) => void
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: QueueWaiter<T>[] = []
  private ended = false
  private error: Error | null = null

  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ done: false, value })
    else this.values.push(value)
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  fail(error: Error): void {
    if (this.ended) return
    this.ended = true
    this.error = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.values.shift()
        if (value !== undefined) return { done: false, value }
        if (this.error) throw this.error
        if (this.ended) return { done: true, value: undefined }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject })
        })
      }
    }
  }
}

type ActiveCodexTurn = {
  queue: AsyncEventQueue<ModelStreamChunk>
  turnId: string
  delegatedToolCalls: number
  interruptRequested: boolean
}

export type CodexAccountModelClientOptions = {
  binaryPath: string
  model: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  legalworkCodexHome?: string
  rpc?: CodexRpcLike
}

export type CodexRpcLike = {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  onNotification(handler: (method: string, params: JsonObject) => void): () => void
  onServerRequest(handler: (request: CodexServerRequest) => Promise<unknown> | unknown): () => void
  stop(): Promise<void>
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function codexTurnErrorCode(message: string): string {
  return /usage limit|rate[ -]?limit|quota|credits? (?:are )?(?:depleted|exhausted)|hit your .*limit/i.test(message)
    ? 'rate_limited'
    : 'codex_turn_failed'
}

function turnItemToResponseItem(item: TurnItem): JsonObject | null {
  switch (item.kind) {
    case 'user_message':
      return {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: item.text }]
      }
    case 'assistant_text':
      return {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: item.text }]
      }
    case 'tool_call':
      return {
        type: 'function_call',
        call_id: item.callId,
        name: item.toolName,
        arguments: JSON.stringify(item.arguments)
      }
    case 'tool_result':
      return {
        type: 'function_call_output',
        call_id: item.callId,
        output: outputText(item.output)
      }
    case 'compaction':
      return {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `[Earlier conversation summary]\n${item.summary}` }]
      }
    case 'review':
      return item.reviewText
        ? {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: item.reviewText }]
          }
        : null
    case 'error':
      return {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `[Previous runtime error]\n${item.message}` }]
      }
    case 'assistant_reasoning':
    case 'approval':
    case 'user_input':
      return null
  }
}

function latestUserIndex(items: readonly TurnItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === 'user_message') return index
  }
  return -1
}

function latestTurnInputs(
  request: ModelRequest,
  userText: string
): JsonObject[] {
  const inputs: JsonObject[] = [{
    type: 'text',
    text: userText || 'Continue from the supplied conversation context.',
    text_elements: []
  }]
  for (const attachment of request.attachments ?? []) {
    inputs.push(codexImageInput(attachment))
  }
  for (const fallback of request.attachmentTextFallbacks ?? []) {
    inputs.push({
      type: 'text',
      text: attachmentFallbackText(fallback),
      text_elements: []
    })
  }
  return inputs
}

function codexImageInput(attachment: ModelInputAttachment): JsonObject {
  if (attachment.localFilePath) {
    return { type: 'localImage', path: attachment.localFilePath }
  }
  return {
    type: 'image',
    url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`
  }
}

function attachmentFallbackText(attachment: ModelTextAttachmentFallback): string {
  const decoded = Buffer.from(attachment.dataBase64, 'base64').toString('utf8')
  return `[Attachment: ${attachment.name} (${attachment.mimeType})]\n${decoded}`
}

function developerInstructions(request: ModelRequest): string {
  const parts = [
    'You are the model transport inside the Legalwork agent runtime.',
    'Do not use Codex built-in shell, filesystem, patch, web, or MCP tools. Use only the client-provided dynamic tools when a tool is needed.',
    'Return the answer for the latest user message. Treat injected history as the authoritative conversation context.',
    request.modeInstruction,
    ...(request.contextInstructions ?? []),
    request.requiredToolName
      ? `This turn must call the dynamic tool named ${request.requiredToolName}.`
      : ''
  ]
  return parts.filter((part): part is string => Boolean(part?.trim())).join('\n\n')
}

/**
 * Uses ChatGPT-managed Codex authentication while preserving Legalwork's
 * existing outer agent/tool loop. Dynamic tool requests are surfaced back as
 * ModelClient tool calls and the Codex turn is interrupted until the host
 * executes them.
 */
export class CodexAccountModelClient implements ModelClient {
  readonly provider = 'codex-chatgpt'
  readonly model: string

  private readonly options: CodexAccountModelClientOptions
  private rpc: CodexRpcLike
  private usingLegalworkAuth = false
  private readonly activeTurns = new Map<string, ActiveCodexTurn>()

  constructor(options: CodexAccountModelClientOptions) {
    this.options = options
    this.model = options.model
    this.rpc = options.rpc ?? this.createRpc(false)
    this.bindRpc(this.rpc)
  }

  async close(): Promise<void> {
    await this.rpc.stop()
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    if (request.abortSignal.aborted) {
      yield { kind: 'error', message: 'request was aborted before start' }
      return
    }
    const queue = new AsyncEventQueue<ModelStreamChunk>()
    let codexThreadId = ''
    const abort = (): void => {
      if (!codexThreadId) return
      const active = this.activeTurns.get(codexThreadId)
      if (!active?.turnId) return
      void this.rpc.request('turn/interrupt', {
        threadId: codexThreadId,
        turnId: active.turnId
      }).catch(() => undefined)
    }
    request.abortSignal.addEventListener('abort', abort, { once: true })
    try {
      const accountInfo = await this.ensureChatGptAccount()
      if (accountInfo.type !== 'chatgpt') {
        yield {
          kind: 'error',
          message: 'Codex is not signed in with ChatGPT. Open Settings > Agents and sign in first.',
          code: 'codex_auth_required'
        }
        return
      }
      const requestedModel = request.model?.trim() || this.options.model
      const started = await this.rpc.request<JsonObject>('thread/start', {
        model: requestedModel,
        cwd: this.options.cwd ?? process.cwd(),
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        serviceName: 'legalwork',
        baseInstructions: request.systemPrompt ?? '',
        developerInstructions: developerInstructions(request),
        dynamicTools: request.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      }, 60_000)
      codexThreadId = stringValue(asObject(started.thread).id)
      if (!codexThreadId) throw new Error('Codex did not return a thread id')

      const userIndex = latestUserIndex(request.history)
      const priorItems = [
        ...request.prefix,
        ...request.history.slice(0, userIndex >= 0 ? userIndex : request.history.length)
      ].map(turnItemToResponseItem).filter((item): item is JsonObject => item !== null)
      if (priorItems.length > 0) {
        await this.rpc.request('thread/inject_items', {
          threadId: codexThreadId,
          items: priorItems
        })
      }
      const latestUser = userIndex >= 0 && request.history[userIndex]?.kind === 'user_message'
        ? request.history[userIndex].text
        : ''
      const active: ActiveCodexTurn = {
        queue,
        turnId: '',
        delegatedToolCalls: 0,
        interruptRequested: false
      }
      this.activeTurns.set(codexThreadId, active)
      const turn = await this.rpc.request<JsonObject>('turn/start', {
        threadId: codexThreadId,
        input: latestTurnInputs(request, latestUser),
        model: requestedModel,
        ...(request.reasoningEffort && request.reasoningEffort !== 'off'
          ? { effort: request.reasoningEffort }
          : {}),
        ...(request.responseFormat === 'json_object'
          ? { outputSchema: { type: 'object' } }
          : {})
      }, 60_000)
      active.turnId = stringValue(asObject(turn.turn).id)
      for await (const chunk of queue) yield chunk
    } catch (error) {
      yield {
        kind: 'error',
        message: `Codex model request failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 'codex_request_failed'
      }
    } finally {
      request.abortSignal.removeEventListener('abort', abort)
      if (codexThreadId) {
        this.activeTurns.delete(codexThreadId)
        void this.rpc.request('thread/unsubscribe', { threadId: codexThreadId }).catch(() => undefined)
      }
    }
  }

  private createRpc(useLegalworkAuth: boolean): CodexRpcLike {
    const legalworkCodexHome = this.options.legalworkCodexHome?.trim()
    return new CodexAppServerRpc({
      binaryPath: this.options.binaryPath,
      env: {
        ...(this.options.env ?? {}),
        ...(useLegalworkAuth && legalworkCodexHome ? { CODEX_HOME: legalworkCodexHome } : {})
      },
      requestTimeoutMs: 60_000
    })
  }

  private bindRpc(rpc: CodexRpcLike): void {
    rpc.onNotification((method, params) => this.handleNotification(method, params))
    rpc.onServerRequest((request) => this.handleServerRequest(request))
  }

  private async ensureChatGptAccount(): Promise<JsonObject> {
    const local = await this.rpc.request<JsonObject>('account/read', { refreshToken: true })
    const localAccount = asObject(local.account)
    const fallbackHome = this.options.legalworkCodexHome?.trim()
    if (localAccount.type === 'chatgpt' || !fallbackHome || this.options.rpc || this.usingLegalworkAuth) {
      return localAccount
    }
    await this.rpc.stop()
    this.rpc = this.createRpc(true)
    this.usingLegalworkAuth = true
    this.bindRpc(this.rpc)
    const fallback = await this.rpc.request<JsonObject>('account/read', { refreshToken: true })
    return asObject(fallback.account)
  }

  private handleNotification(method: string, params: JsonObject): void {
    const threadId = stringValue(params.threadId)
    const active = threadId ? this.activeTurns.get(threadId) : undefined
    if (!active) return
    const turnId = stringValue(params.turnId) || stringValue(asObject(params.turn).id)
    if (active.turnId && turnId && active.turnId !== turnId) return
    if (method === 'item/agentMessage/delta') {
      const delta = stringValue(params.delta)
      if (delta) active.queue.push({ kind: 'assistant_text_delta', text: delta })
      return
    }
    if (method === 'item/reasoning/summaryTextDelta') {
      const delta = stringValue(params.delta)
      if (delta) active.queue.push({ kind: 'assistant_reasoning_delta', text: delta })
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const last = asObject(asObject(params.tokenUsage).last)
      const promptTokens = Number(last.inputTokens) || 0
      const completionTokens = Number(last.outputTokens) || 0
      const cachedTokens = Number(last.cachedInputTokens) || 0
      active.queue.push({
        kind: 'usage',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: Number(last.totalTokens) || promptTokens + completionTokens,
          cachedTokens,
          cacheHitTokens: cachedTokens,
          cacheMissTokens: Math.max(0, promptTokens - cachedTokens),
          cacheHitRate: promptTokens > 0 ? cachedTokens / promptTokens : null,
          turns: 1
        }
      })
      return
    }
    if (method === 'turn/completed') {
      const turn = asObject(params.turn)
      const status = stringValue(turn.status)
      if (status === 'failed') {
        const error = asObject(turn.error)
        const message = stringValue(error.message) || 'Codex turn failed'
        active.queue.push({
          kind: 'error',
          message,
          code: codexTurnErrorCode(message)
        })
        active.queue.push({ kind: 'completed', stopReason: 'error' })
      } else {
        active.queue.push({
          kind: 'completed',
          stopReason: active.delegatedToolCalls > 0 ? 'tool_calls' : 'stop'
        })
      }
      active.queue.close()
    }
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<unknown> {
    if (request.method !== 'item/tool/call') return undefined
    const threadId = stringValue(request.params.threadId)
    const active = this.activeTurns.get(threadId)
    if (!active) return undefined
    const toolName = stringValue(request.params.tool)
    const callId = stringValue(request.params.callId)
    if (!toolName || !callId) throw new Error('Codex dynamic tool request was incomplete')
    active.delegatedToolCalls += 1
    active.queue.push({
      kind: 'tool_call_complete',
      callId,
      toolName,
      arguments: asObject(request.params.arguments)
    })
    if (!active.interruptRequested) {
      active.interruptRequested = true
      queueMicrotask(() => {
        void this.rpc.request('turn/interrupt', {
          threadId,
          turnId: stringValue(request.params.turnId)
        }).catch(() => undefined)
      })
    }
    return {
      contentItems: [{
        type: 'inputText',
        text: 'The host accepted this tool call and will execute it before the next model turn.'
      }],
      success: true
    }
  }
}
