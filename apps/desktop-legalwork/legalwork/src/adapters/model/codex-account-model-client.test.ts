import { describe, expect, it } from 'vitest'
import type { ModelRequest } from '../../ports/model-client.js'
import {
  CodexAccountModelClient,
  type CodexRpcLike
} from './codex-account-model-client.js'
import type { CodexServerRequest } from './codex-app-server-rpc.js'

type JsonObject = Record<string, unknown>

class FakeCodexRpc implements CodexRpcLike {
  notificationHandler: ((method: string, params: JsonObject) => void) | null = null
  serverRequestHandler: ((request: CodexServerRequest) => Promise<unknown> | unknown) | null = null
  toolMode = false
  toolCompletionStatus: 'completed' | 'interrupted' | 'failed' = 'interrupted'
  errorMessage = ''
  errorInfo: unknown = null
  models: JsonObject[] = [{
    id: 'gpt-test',
    model: 'gpt-test',
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
    defaultReasoningEffort: 'medium'
  }]
  modelListFails = false
  requests: Array<{ method: string; params?: unknown }> = []

  onNotification(handler: (method: string, params: JsonObject) => void): () => void {
    this.notificationHandler = handler
    return () => undefined
  }

  onServerRequest(handler: (request: CodexServerRequest) => Promise<unknown> | unknown): () => void {
    this.serverRequestHandler = handler
    return () => undefined
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'account/read') return { account: { type: 'chatgpt' } } as T
    if (method === 'model/list') {
      if (this.modelListFails) throw new Error('catalog unavailable')
      return { data: this.models } as T
    }
    if (method === 'thread/start') return { thread: { id: 'codex-thread' } } as T
    if (method === 'thread/inject_items') return {} as T
    if (method === 'thread/unsubscribe' || method === 'turn/interrupt') return {} as T
    if (method === 'turn/start') {
      queueMicrotask(() => {
        if (this.errorMessage) {
          this.notificationHandler?.('turn/completed', {
            threadId: 'codex-thread',
            turn: {
              id: 'codex-turn',
              status: 'failed',
              error: { message: this.errorMessage, codexErrorInfo: this.errorInfo }
            }
          })
          return
        }
        if (this.toolMode) {
          void Promise.resolve(this.serverRequestHandler?.({
            id: 9,
            method: 'item/tool/call',
            params: {
              threadId: 'codex-thread',
              turnId: 'codex-turn',
              callId: 'call-1',
              tool: 'lookup_case',
              arguments: { query: 'demo' }
            }
          })).then(() => {
            this.notificationHandler?.('turn/completed', {
              threadId: 'codex-thread',
              turn: {
                id: 'codex-turn',
                status: this.toolCompletionStatus,
                ...(this.toolCompletionStatus === 'failed'
                  ? { error: { message: 'Codex turn failed' } }
                  : {})
              }
            })
          })
          return
        }
        this.notificationHandler?.('item/agentMessage/delta', {
          threadId: 'codex-thread',
          turnId: 'codex-turn',
          delta: 'OK'
        })
        this.notificationHandler?.('turn/completed', {
          threadId: 'codex-thread',
          turn: { id: 'codex-turn', status: 'completed' }
        })
      })
      return { turn: { id: 'codex-turn' }, params } as T
    }
    return {} as T
  }

  async stop(): Promise<void> {}
}

function request(tools: ModelRequest['tools'] = []): ModelRequest {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    model: 'gpt-test',
    systemPrompt: 'System prompt',
    prefix: [],
    history: [{
      id: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      role: 'user',
      status: 'completed',
      createdAt: new Date(0).toISOString(),
      kind: 'user_message',
      text: 'Reply'
    }],
    tools,
    abortSignal: new AbortController().signal
  }
}

describe('CodexAccountModelClient', () => {
  it('maps Codex text deltas to the Legalwork model stream', async () => {
    const rpc = new FakeCodexRpc()
    const client = new CodexAccountModelClient({ binaryPath: 'codex', model: 'gpt-test', rpc })
    const chunks = []
    for await (const chunk of client.stream(request())) chunks.push(chunk)
    expect(chunks).toContainEqual({ kind: 'assistant_text_delta', text: 'OK' })
    expect(chunks).toContainEqual({ kind: 'completed', stopReason: 'stop' })
  })

  it('requests and maps detailed Codex reasoning summaries', async () => {
    const rpc = new FakeCodexRpc()
    const originalRequest = rpc.request.bind(rpc)
    rpc.request = async <T = unknown>(method: string, params?: unknown): Promise<T> => {
      if (method === 'turn/start') {
        queueMicrotask(() => {
          rpc.notificationHandler?.('item/reasoning/summaryTextDelta', {
            threadId: 'codex-thread',
            turnId: 'codex-turn',
            delta: 'Inspect the source, then draft the answer.'
          })
        })
      }
      return originalRequest<T>(method, params)
    }
    const client = new CodexAccountModelClient({ binaryPath: 'codex', model: 'gpt-test', rpc })
    const chunks = []
    for await (const chunk of client.stream(request())) chunks.push(chunk)

    const threadStart = rpc.requests.find((entry) => entry.method === 'thread/start')
    expect(threadStart?.params).toEqual(expect.objectContaining({
      config: expect.objectContaining({ model_reasoning_summary: 'detailed' })
    }))
    expect(chunks).toContainEqual({
      kind: 'assistant_reasoning_delta',
      text: 'Inspect the source, then draft the answer.'
    })
  })

  it('delegates Codex dynamic tools back to the Legalwork tool loop', async () => {
    const rpc = new FakeCodexRpc()
    rpc.toolMode = true
    const client = new CodexAccountModelClient({ binaryPath: 'codex', model: 'gpt-test', rpc })
    const chunks = []
    for await (const chunk of client.stream(request([{
      name: 'lookup_case',
      description: 'Look up a case',
      inputSchema: { type: 'object' }
    }]))) chunks.push(chunk)
    expect(chunks).toContainEqual({
      kind: 'tool_call_complete',
      callId: 'call-1',
      toolName: 'lookup_case',
      arguments: { query: 'demo' }
    })
    expect(chunks).toContainEqual({ kind: 'completed', stopReason: 'tool_calls' })
  })

  it('keeps an accepted tool call when the intentional interrupt is reported as failed', async () => {
    const rpc = new FakeCodexRpc()
    rpc.toolMode = true
    rpc.toolCompletionStatus = 'failed'
    const client = new CodexAccountModelClient({ binaryPath: 'codex', model: 'gpt-test', rpc })
    const chunks = []
    for await (const chunk of client.stream(request([{
      name: 'lookup_case',
      description: 'Look up a case',
      inputSchema: { type: 'object' }
    }]))) chunks.push(chunk)
    expect(chunks).toContainEqual({
      kind: 'tool_call_complete',
      callId: 'call-1',
      toolName: 'lookup_case',
      arguments: { query: 'demo' }
    })
    expect(chunks).not.toContainEqual(expect.objectContaining({ kind: 'error' }))
    expect(chunks).toContainEqual({ kind: 'completed', stopReason: 'tool_calls' })
  })

  it('uses the account default instead of a stale DeepSeek model and clamps effort', async () => {
    const rpc = new FakeCodexRpc()
    rpc.models = [{
      id: 'gpt-free',
      model: 'gpt-free',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      defaultReasoningEffort: 'low'
    }]
    const client = new CodexAccountModelClient({
      binaryPath: 'codex',
      model: 'deepseek-v4-flash',
      rpc
    })
    const modelRequest = request()
    modelRequest.model = 'deepseek-v4-flash'
    modelRequest.reasoningEffort = 'max'
    for await (const _chunk of client.stream(modelRequest)) {
      // Drain the model stream.
    }
    const threadStart = rpc.requests.find((entry) => entry.method === 'thread/start')
    const turnStart = rpc.requests.find((entry) => entry.method === 'turn/start')
    expect(threadStart?.params).toEqual(expect.objectContaining({
      model: 'gpt-free',
      config: expect.objectContaining({
        features: expect.objectContaining({ shell_tool: false, unified_exec: false })
      })
    }))
    expect(turnStart?.params).toEqual(expect.objectContaining({
      model: 'gpt-free',
      effort: 'low'
    }))
  })

  it('lets Codex choose the account default when the model catalog is unavailable', async () => {
    const rpc = new FakeCodexRpc()
    rpc.modelListFails = true
    const client = new CodexAccountModelClient({
      binaryPath: 'codex',
      model: 'deepseek-v4-flash',
      rpc
    })
    const modelRequest = request()
    modelRequest.model = 'deepseek-v4-flash'
    for await (const _chunk of client.stream(modelRequest)) {
      // Drain the model stream.
    }
    const threadStart = rpc.requests.find((entry) => entry.method === 'thread/start')
    const turnStart = rpc.requests.find((entry) => entry.method === 'turn/start')
    expect(threadStart?.params).not.toEqual(expect.objectContaining({ model: expect.anything() }))
    expect(turnStart?.params).not.toEqual(expect.objectContaining({ model: expect.anything() }))
  })

  it('classifies exhausted ChatGPT usage as a rate limit', async () => {
    const rpc = new FakeCodexRpc()
    rpc.errorMessage = "You've hit your usage limit. Try again later."
    const client = new CodexAccountModelClient({ binaryPath: 'codex', model: 'gpt-test', rpc })
    const chunks = []
    for await (const chunk of client.stream(request())) chunks.push(chunk)
    expect(chunks).toContainEqual({
      kind: 'error',
      message: "You've hit your usage limit. Try again later.",
      code: 'rate_limited'
    })
    expect(chunks).toContainEqual({ kind: 'completed', stopReason: 'error' })
  })

  it('uses Codex metadata when a free-account failure has only a generic message', async () => {
    const rpc = new FakeCodexRpc()
    rpc.errorMessage = 'Codex turn failed'
    rpc.errorInfo = 'usageLimitExceeded'
    const client = new CodexAccountModelClient({ binaryPath: 'codex', model: 'gpt-test', rpc })
    const chunks = []
    for await (const chunk of client.stream(request())) chunks.push(chunk)
    expect(chunks).toContainEqual({
      kind: 'error',
      message: expect.stringContaining('usage limit reached'),
      code: 'rate_limited'
    })
  })
})
