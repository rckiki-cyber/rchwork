import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryEventBus } from '../src/adapters/in-memory-event-bus.js'
import { LocalToolHost, buildDefaultLocalTools } from '../src/adapters/tool/local-tool-host.js'
import { CREATE_PLAN_TOOL_NAME } from '../src/adapters/tool/create-plan-tool.js'
import { GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME } from '../src/adapters/tool/goal-tools.js'
import { FileThreadStore, FileSessionStore } from '../src/adapters/file/index.js'
import { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import { ContextCompactor } from '../src/loop/context-compactor.js'
import {
  DEFAULT_MAX_AGENT_LOOP_STEPS,
  MAX_AGENT_LOOP_STEPS_ENV,
  MAX_AGENT_LOOP_STEPS_ENV_CAP,
  isBareResearchTopicPrompt,
  requestedDocumentArtifacts,
  requestsLocalKnowledgeRetrieval,
  requestsDocumentMutation,
  resolveMaxAgentLoopSteps,
  skillRoutingPrompt
} from '../src/loop/agent-loop.js'
import { resolveModelContextProfile } from '../src/loop/model-context-profile.js'
import { makeAssistantTextItem, makeToolCallItem, makeUserItem } from '../src/domain/item.js'
import { createThreadRecord } from '../src/domain/thread.js'
import { createImmutablePrefix, setSystemPrompt } from '../src/cache/immutable-prefix.js'
import type { TurnItem } from '../src/contracts/items.js'
import type { ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'
import {
  bootstrapThread,
  makeFakeModel,
  makeHarness,
  makeSilentModel,
  resolveNextUserInput
} from './loop-test-harness.js'

describe('AgentLoop', () => {
  it('distinguishes document creation requests from formatting questions', () => {
    expect(requestsDocumentMutation('写一篇文献综述 Word 给我')).toBe(true)
    expect(requestsDocumentMutation('把这份 .docx 按论文格式排版')).toBe(true)
    expect(requestsDocumentMutation('请问可以帮我生成一份 Word 吗？')).toBe(true)
    expect(requestsDocumentMutation('如何设置 Word 的页边距？')).toBe(false)
    expect(requestsDocumentMutation('为什么 Word 正文通常使用宋体？')).toBe(false)
    expect(requestsDocumentMutation('Word 文档有哪些常用格式？')).toBe(false)
  })

  it('tracks every explicitly requested deliverable format', () => {
    const request = '请完成研究并交付 Word、PDF、PPT 三份完整文件'
    expect(requestedDocumentArtifacts(request)).toEqual(['docx', 'pdf', 'pptx'])
    expect(requestedDocumentArtifacts('请生成一份研究报告')).toEqual(['docx'])
    expect(requestsLocalKnowledgeRetrieval('先检索本地知识库，再生成报告')).toBe(true)
  })

  it('does not treat a bare academic title as authorization for paid research', () => {
    expect(isBareResearchTopicPrompt('行政程序与人工智能的媾和')).toBe(true)
    expect(isBareResearchTopicPrompt('自动化/半自动化行政行为的程序要件如何重构')).toBe(false)
    expect(isBareResearchTopicPrompt('检索知识库')).toBe(false)
    expect(isBareResearchTopicPrompt('写一篇文献综述word')).toBe(false)
  })

  it('inherits the previous substantive Skill context for terse follow-ups', () => {
    const items: TurnItem[] = [
      makeUserItem({
        id: 'u_word',
        turnId: 'turn_word',
        threadId: 'thr_1',
        text: '写一篇文献综述word'
      }),
      makeUserItem({
        id: 'u_question',
        turnId: 'turn_question',
        threadId: 'thr_1',
        text: '？'
      })
    ]

    expect(skillRoutingPrompt('？', items, 'turn_question')).toContain('写一篇文献综述word')
    expect(skillRoutingPrompt('重新分析合同', items, 'turn_new')).toBe('重新分析合同')
  })

  it('resolves a configurable agent loop step limit', () => {
    expect(resolveMaxAgentLoopSteps({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MAX_AGENT_LOOP_STEPS)
    expect(resolveMaxAgentLoopSteps({ [MAX_AGENT_LOOP_STEPS_ENV]: '1024' } as NodeJS.ProcessEnv)).toBe(1024)
    expect(resolveMaxAgentLoopSteps({ [MAX_AGENT_LOOP_STEPS_ENV]: '0' } as NodeJS.ProcessEnv))
      .toBe(DEFAULT_MAX_AGENT_LOOP_STEPS)
    expect(resolveMaxAgentLoopSteps({ [MAX_AGENT_LOOP_STEPS_ENV]: '999999' } as NodeJS.ProcessEnv))
      .toBe(MAX_AGENT_LOOP_STEPS_ENV_CAP)
  })

  it('finishes a silent model run as completed', async () => {
    const h = makeHarness(makeSilentModel())
    await bootstrapThread(h)
    const status = await h.loop.runTurn(h.threadId, h.turnId)
    expect(status).toBe('completed')
    expect(h.inflight.size()).toBe(0)
  })

  it('injects the current shell runtime when bash is available', async () => {
    let observedRequest: ModelRequest | null = null
    const h = makeHarness({
      provider: 'shell-context',
      model: 'shell-context',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        observedRequest = request
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await bootstrapThread(h)

    await h.loop.runTurn(h.threadId, h.turnId)

    const request = observedRequest as ModelRequest | null
    if (!request) throw new Error('expected model request')
    expect(request.tools.map((tool) => tool.name)).toContain('bash')
    expect(request.contextInstructions?.join('\n')).toContain('Shell runtime:')
    expect(request.contextInstructions?.join('\n')).toContain('shell commands appropriate for the host platform')
  })

  it('injects the primary legal research source instruction when configured', async () => {
    let observedRequest: ModelRequest | null = null
    const h = makeHarness({
      provider: 'primary-source',
      model: 'primary-source',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        observedRequest = request
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, { primaryLegalSource: 'pkulaw' })
    await bootstrapThread(h)
    await h.loop.runTurn(h.threadId, h.turnId)

    const request = observedRequest as ModelRequest | null
    if (!request) throw new Error('expected model request')
    const instructions = request.contextInstructions?.join('\n') ?? ''
    expect(instructions).toContain('北大法宝(PKULaw)')
    expect(instructions).toContain('元典(Yuandian)')
    expect(instructions).toContain('优先使用')
  })

  it('does not inject the primary source instruction when unset', async () => {
    let observedRequest: ModelRequest | null = null
    const h = makeHarness({
      provider: 'no-primary-source',
      model: 'no-primary-source',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        observedRequest = request
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await bootstrapThread(h)
    await h.loop.runTurn(h.threadId, h.turnId)

    const request = observedRequest as ModelRequest | null
    if (!request) throw new Error('expected model request')
    const instructions = request.contextInstructions?.join('\n') ?? ''
    expect(instructions).not.toContain('首要来源')
  })

  it('records elapsed seconds for active goals after a turn finishes', async () => {
    let nowMs = 1_000
    const h = makeHarness(
      {
        provider: 'goal-timer',
        model: 'goal-timer',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          nowMs = 4_700
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { nowMs: () => nowMs }
    )
    await bootstrapThread(h)
    await h.threads.setGoal(h.threadId, { objective: 'ship the feature' })

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const goal = await h.threads.getGoal(h.threadId)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)

    expect(status).toBe('completed')
    expect(goal?.timeUsedSeconds).toBe(3)
    expect(events.some((event) =>
      event.kind === 'goal_updated' && event.goal?.timeUsedSeconds === 3
    )).toBe(true)
  })

  it('includes the failure reason on turn_failed events', async () => {
    const h = makeHarness({
      provider: 'throwing',
      model: 'throwing',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        const chunks: ModelStreamChunk[] = []
        for (const chunk of chunks) yield chunk
        throw new Error('model stream exploded')
      }
    })
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const failed = events.find((event) => event.kind === 'turn_failed')

    expect(status).toBe('failed')
    expect(failed).toMatchObject({
      kind: 'turn_failed',
      message: 'model stream exploded'
    })
  })

  it('fails the turn when the model stream yields an error chunk', async () => {
    const h = makeHarness({
      provider: 'error-chunk',
      model: 'error-chunk',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        yield { kind: 'error', message: 'model request failed with status 400', code: 'http_400' }
      }
    })
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)

    expect(status).toBe('failed')
    expect(events.some((event) =>
      event.kind === 'error' &&
      event.message === 'model request failed with status 400' &&
      event.code === 'http_400'
    )).toBe(true)
    expect(events.some((event) => event.kind === 'turn_failed')).toBe(true)
  })

  it('emits named pipeline lifecycle stages for a model request', async () => {
    const h = makeHarness(makeSilentModel())
    await bootstrapThread(h)

    await h.loop.runTurn(h.threadId, h.turnId)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const stages = events
      .filter((event) => event.kind === 'pipeline_stage')
      .map((event) => event.kind === 'pipeline_stage' ? event.stage : '')

    expect(stages).toEqual([
      'setup',
      'pre_start',
      'post_start',
      'input_received',
      'input_cached',
      'input_routed',
      'input_compressed',
      'input_remembered',
      'pre_send',
      'post_send',
      'response_received'
    ])
  })

  it('aborts the turn when the abort signal fires', async () => {
    const h = makeHarness({
      provider: 'blocker',
      model: 'blocker',
      async *stream({ abortSignal }): AsyncIterable<ModelStreamChunk> {
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) return resolve()
          abortSignal.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { kind: 'error', message: 'aborted' }
      }
    })
    await bootstrapThread(h)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 5)
    h.turns['inflightTurns'].set(h.turnId, controller)
    const status = await h.loop.runTurn(h.threadId, h.turnId)
    expect(status === 'aborted' || status === 'failed').toBe(true)
    expect(h.inflight.size()).toBe(0)
  })

  it('can discard generated items when interrupting a foreground turn', async () => {
    const h = makeHarness(makeSilentModel())
    await bootstrapThread(h)
    await h.turns.applyItem(
      h.threadId,
      makeAssistantTextItem({
        id: 'partial_answer',
        turnId: h.turnId,
        threadId: h.threadId,
        text: 'partial',
        status: 'running'
      })
    )

    await h.turns.interruptTurn({ threadId: h.threadId, turnId: h.turnId, discard: true })
    const sessionItems = await h.sessionStore.loadItems(h.threadId)
    const thread = await h.threadStore.get(h.threadId)
    const turnItems = thread?.turns.find((turn) => turn.id === h.turnId)?.items ?? []

    expect(sessionItems.filter((item) => item.turnId === h.turnId).map((item) => item.kind))
      .toEqual(['user_message'])
    expect(turnItems.map((item) => item.kind)).toEqual(['user_message'])
  })

  it('runs a tool call and surfaces its result item', async () => {
    let calls = 0
    const h = makeHarness({
      provider: 'fake',
      model: 'fake',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        calls += 1
        if (calls === 1) {
          yield {
            kind: 'tool_call_complete',
            callId: 'call_echo',
            toolName: 'echo',
            arguments: { text: 'hi' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await bootstrapThread(h)
    const status = await h.loop.runTurn(h.threadId, h.turnId)
    expect(status).toBe('completed')
    const items = await h.sessionStore.loadItems(h.threadId)
    const result = items.find((item) => item.kind === 'tool_result')
    expect(result).toBeDefined()
    if (result?.kind === 'tool_result') {
      expect(result.toolName).toBe('echo')
    }
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    expect(events.some((event) => event.kind === 'tool_call_ready' && event.readyCount === 1)).toBe(true)
    expect(events.some((event) =>
      event.kind === 'tool_result_upload_wait' && event.toolResultCount === 1
    )).toBe(true)
    const thread = await h.threadStore.get(h.threadId)
    const toolCall = thread?.turns
      .flatMap((turn) => turn.items)
      .find((item) => item.kind === 'tool_call' && item.callId === 'call_echo')
    expect(toolCall).toMatchObject({ kind: 'tool_call', status: 'completed' })
  })

  it('removes research tools after the cumulative turn input budget is exhausted', async () => {
    const requests: ModelRequest[] = []
    const h = makeHarness({
      provider: 'budget-guard',
      model: 'budget-guard',
      async *stream(request): AsyncIterable<ModelStreamChunk> {
        requests.push(request)
        if (requests.length === 1) {
          yield {
            kind: 'usage',
            usage: {
              promptTokens: 100,
              completionTokens: 1,
              totalTokens: 101,
              cachedTokens: 0,
              cacheHitTokens: 0,
              cacheMissTokens: 100,
              cacheHitRate: 0,
              turns: 1
            }
          }
          yield {
            kind: 'tool_call_complete',
            callId: 'call_echo',
            toolName: 'echo',
            arguments: { text: 'one last search' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, { turnTokenBudget: 50 })
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(requests).toHaveLength(2)
    expect(requests[0]?.tools.map((tool) => tool.name)).toContain('echo')
    expect(requests[1]?.tools).toEqual([])
    expect(requests[1]?.contextInstructions?.join('\n')).toContain('成本预算提醒')
  })

  it('enforces IMA research for knowledge-heavy legal work when the model skips the tool', async () => {
    const requests: ModelRequest[] = []
    let executions = 0
    const imaResearchTool = LocalToolHost.defineTool({
      name: 'mcp_ima_knowledge_base_research_ima',
      description: 'Automatically route and research IMA knowledge bases.',
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question']
      },
      policy: 'auto',
      execute: async (args) => {
        executions += 1
        return { output: { answer: 'IMA 返回了可用于分析劳动合同解除风险的知识库证据。', question: args.question } }
      }
    })
    const h = makeHarness(
      {
        provider: 'ima-route',
        model: 'ima-route',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          yield { kind: 'assistant_text_delta', text: '已结合 IMA 回答。' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [imaResearchTool] }
    )
    const question = '请分析企业解除劳动合同的合规风险和法律依据'
    await bootstrapThread(h, { request: { prompt: question } })

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const items = await h.sessionStore.loadItems(h.threadId)

    expect(status).toBe('completed')
    expect(executions).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.requiredToolName).toBeUndefined()
    expect(requests[0]?.contextInstructions?.join('\n') ?? '').not.toContain('<ima_auto_route>')
    expect(requests[0]?.history.some((item) =>
      item.kind === 'tool_result' && item.toolName === 'mcp_ima_knowledge_base_research_ima'
    )).toBe(true)
    expect(items.some((item) =>
      item.kind === 'tool_result' &&
      item.toolName === 'mcp_ima_knowledge_base_research_ima' &&
      item.isError !== true
    )).toBe(true)
  })

  it('enforces IMA discovery and call in progressive MCP mode', async () => {
    const executed: Array<{ name: string; args: Record<string, unknown> }> = []
    const mcpSearch = LocalToolHost.defineTool({
      name: 'mcp_search',
      description: 'Search MCP catalog.',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async (args) => {
        executed.push({ name: 'mcp_search', args })
        return {
          output: {
            results: [{ toolId: 'ima-knowledge-base/research_ima' }]
          }
        }
      }
    })
    const mcpCall = LocalToolHost.defineTool({
      name: 'mcp_call',
      description: 'Call MCP tool.',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async (args) => {
        executed.push({ name: 'mcp_call', args })
        return {
          output: {
            serverId: 'ima-knowledge-base',
            toolName: 'research_ima',
            result: 'IMA 返回了可用于研究人工智能生成内容监管的知识库证据。'
          }
        }
      }
    })
    let requests = 0
    const h = makeHarness(
      {
        provider: 'ima-progressive-route',
        model: 'ima-progressive-route',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          requests += 1
          yield { kind: 'assistant_text_delta', text: '已使用渐进发现的 IMA 工具。' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [mcpSearch, mcpCall] }
    )
    const question = '请研究人工智能生成内容的法律监管问题'
    await bootstrapThread(h, { request: { prompt: question } })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(requests).toBe(1)
    expect(executed.map((entry) => entry.name)).toEqual(['mcp_search', 'mcp_call'])
    expect(executed[0]?.args).toMatchObject({ serverId: 'ima-knowledge-base' })
    expect(executed[1]?.args).toEqual({
      toolId: 'ima-knowledge-base/research_ima',
      arguments: { question, timeout: 210 }
    })
  })

  it('returns control to the model after a progressive IMA call fails', async () => {
    const executed: string[] = []
    const mcpSearch = LocalToolHost.defineTool({
      name: 'mcp_search',
      description: 'Search MCP catalog.',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async () => {
        executed.push('mcp_search')
        return {
          output: {
            results: [{ toolId: 'ima-knowledge-base/research_ima' }]
          }
        }
      }
    })
    const mcpCall = LocalToolHost.defineTool({
      name: 'mcp_call',
      description: 'Call MCP tool.',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async () => {
        executed.push('mcp_call')
        return {
          output: { error: 'MCP error -32001: Request timed out' },
          isError: true
        }
      }
    })
    const requests: ModelRequest[] = []
    const h = makeHarness(
      {
        provider: 'ima-progressive-failure',
        model: 'ima-progressive-failure',
        async *stream(request): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          yield { kind: 'assistant_text_delta', text: 'IMA 超时，已基于现有材料继续。' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [mcpSearch, mcpCall] }
    )
    await bootstrapThread(h, {
      request: { prompt: '请研究人工智能生成内容的法律监管问题' }
    })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(executed).toEqual(['mcp_search', 'mcp_call'])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.history.some((item) =>
      item.kind === 'tool_result' &&
      item.toolName === 'mcp_call' &&
      item.isError === true
    )).toBe(true)
  })

  it('retrieves local knowledge before IMA and completes every requested file format', async () => {
    const executed: Array<{ name: string; args: Record<string, unknown> }> = []
    const define = (
      name: string,
      execute: (args: Record<string, unknown>) => Promise<{ output: unknown; isError?: boolean }>
    ) => LocalToolHost.defineTool({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute
    })
    const tools = [
      define('knowledge_auto_retrieve', async (args) => {
        executed.push({ name: 'knowledge_auto_retrieve', args })
        return {
          output: {
            sources: [{ path: '行政处罚法研究.pdf' }],
            contextText: '本地知识库文献指出，自动化行政处罚仍需满足法定程序、说明理由与责任可追溯要求。'
          }
        }
      }),
      define('mcp_search', async (args) => {
        executed.push({ name: 'mcp_search', args })
        return { output: { results: [{ toolId: 'ima-knowledge-base/research_ima' }] } }
      }),
      define('mcp_call', async (args) => {
        executed.push({ name: 'mcp_call', args })
        return {
          output: {
            serverId: 'ima-knowledge-base',
            toolName: 'research_ima',
            result: 'IMA 返回了自动化行政处罚责任界定的相关论文观点与来源证据。'
          }
        }
      }),
      define('document_skill_execute', async (args) => {
        executed.push({ name: 'document_skill_execute', args })
        const kind = String(args.kind ?? '')
        const operation = String(args.operation ?? '')
        return {
          output: {
            status: 'ok',
            kind,
            operation,
            output: `/tmp/report.${kind}`
          }
        }
      })
    ]
    let callIndex = 0
    const requests: ModelRequest[] = []
    const h = makeHarness({
      provider: 'compound-delivery',
      model: 'compound-delivery',
      async *stream(request): AsyncIterable<ModelStreamChunk> {
        requests.push(request)
        if (request.requiredToolName === 'knowledge_auto_retrieve') {
          yield {
            kind: 'tool_call_complete',
            callId: `call_compound_${++callIndex}`,
            toolName: 'knowledge_auto_retrieve',
            arguments: { question: '自动化行政处罚责任界定' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        if (request.requiredToolName === 'document_skill_execute') {
          const progress = request.contextInstructions?.join('\n') ?? ''
          const kind = progress.includes('本步仍需生成：DOCX')
            ? 'docx'
            : progress.includes('本步仍需生成：PDF')
              ? 'pdf'
              : 'pptx'
          const operation = kind === 'docx'
            ? 'from-markdown'
            : kind === 'pdf'
              ? 'from-docx'
              : 'from-json'
          yield {
            kind: 'tool_call_complete',
            callId: `call_compound_${++callIndex}`,
            toolName: 'document_skill_execute',
            arguments: { kind, operation }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: '三份文件均已生成。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, { tools })
    await bootstrapThread(h, {
      request: {
        prompt: '请先检索本地知识库，再检索 IMA，研究自动化行政处罚责任界定，并交付 Word、PDF、PPT 三份完整文件。'
      }
    })

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const documentKinds = executed
      .filter((entry) => entry.name === 'document_skill_execute')
      .map((entry) => entry.args.kind)

    expect(status).toBe('completed')
    expect(executed.map((entry) => entry.name)).toEqual([
      'knowledge_auto_retrieve',
      'mcp_search',
      'mcp_call',
      'document_skill_execute',
      'document_skill_execute',
      'document_skill_execute'
    ])
    expect(documentKinds).toEqual(['docx', 'pdf', 'pptx'])
    expect(requests.at(-1)?.requiredToolName).toBeUndefined()
  })

  it('falls back to local search and blocks generation when local KB has no evidence', async () => {
    const executed: string[] = []
    const define = (
      name: string,
      output: unknown
    ) => LocalToolHost.defineTool({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async () => {
        executed.push(name)
        return { output }
      }
    })
    const requests: ModelRequest[] = []
    const h = makeHarness({
      provider: 'local-evidence-barrier',
      model: 'local-evidence-barrier',
      async *stream(request): AsyncIterable<ModelStreamChunk> {
        requests.push(request)
        if (request.requiredToolName === 'knowledge_auto_retrieve') {
          yield {
            kind: 'tool_call_complete',
            callId: 'call_local_auto_empty',
            toolName: 'knowledge_auto_retrieve',
            arguments: { query: '行政法研究' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        if (request.requiredToolName === 'knowledge_search') {
          yield {
            kind: 'tool_call_complete',
            callId: 'call_local_search_empty',
            toolName: 'knowledge_search',
            arguments: { query: '行政法研究' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: '本地知识库没有返回可用证据，未生成文件。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, {
      tools: [
        define('knowledge_auto_retrieve', { sources: [], contextText: '' }),
        define('knowledge_search', { sources: [] }),
        define('document_skill_execute', { status: 'ok', output: '/tmp/should-not-exist.docx' })
      ]
    })
    await bootstrapThread(h, {
      request: { prompt: '请先检索本地知识库，再生成 Word 报告。' }
    })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(executed).toEqual(['knowledge_auto_retrieve', 'knowledge_search'])
    expect(requests.at(-1)?.tools).toEqual([])
    expect(requests.at(-1)?.contextInstructions?.join('\n')).toContain('本地知识库未返回')
  })

  it('requires successful citation verification before generating a KB-grounded literature review', async () => {
    const executed: string[] = []
    const define = (
      name: string,
      output: unknown
    ) => LocalToolHost.defineTool({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async () => {
        executed.push(name)
        return { output }
      }
    })
    let callIndex = 0
    const h = makeHarness({
      provider: 'citation-evidence-barrier',
      model: 'citation-evidence-barrier',
      async *stream(request): AsyncIterable<ModelStreamChunk> {
        const required = request.requiredToolName
        if (required) {
          yield {
            kind: 'tool_call_complete',
            callId: `call_citation_gate_${++callIndex}`,
            toolName: required,
            arguments: required === 'knowledge_citation_verify'
              ? { draft: '正文引用[1]\n参考文献\n[1] 张三. 算法行政研究[J]. 法学研究, 2025.' }
              : required === 'document_skill_execute'
                ? {
                    kind: 'docx',
                    operation: 'from-markdown',
                    content: '正文引用[1]\n参考文献\n[1] 张三. 算法行政研究[J]. 法学研究, 2025.'
                  }
                : { query: '算法行政 文献综述' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: '已基于核验来源生成综述。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, {
      tools: [
        define('knowledge_auto_retrieve', {
          sources: [{ path: '算法行政研究.pdf' }],
          contextText: '本地论文系统讨论了算法行政的权力属性、正当程序、透明度与司法审查问题。'
        }),
        define('mcp_ima_knowledge_base_research_ima', {
          answer: 'IMA 返回了算法行政、自动化行政行为和算法正当程序方面的论文与来源证据。'
        }),
        define('knowledge_citation_verify', { verificationPassed: true }),
        define('document_skill_execute', {
          status: 'ok',
          kind: 'docx',
          operation: 'from-markdown',
          output: '/tmp/verified-review.docx'
        })
      ]
    })
    await bootstrapThread(h, {
      request: {
        prompt: '请先检索本地知识库和 IMA，撰写算法行政文献综述并生成 Word，引用需标注出处。'
      }
    })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(executed).toEqual([
      'knowledge_auto_retrieve',
      'mcp_ima_knowledge_base_research_ima',
      'knowledge_citation_verify',
      'document_skill_execute'
    ])
  })

  it('enforces a complex report contract before citation verification and Word/PDF delivery', async () => {
    const executed: string[] = []
    const fullDraft = [
      '# 一、问题的提出',
      '# 二、规范体系',
      '脱敏处理采用去标识化、替换直接标识符并保留受控主体映射。',
      '典型案例包括（2019）鲁13行终415号与（2021）京01行终88号。',
      '完整论证内容。'.repeat(140),
      '# 参考文献',
      '[1] 本地知识库论文一。'
    ].join('\n')
    const define = (
      name: string,
      execute: (args: Record<string, unknown>) => Promise<{ output: unknown; isError?: boolean }>
    ) => LocalToolHost.defineTool({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute
    })
    const tools = [
      define('knowledge_auto_retrieve', async () => {
        executed.push('knowledge_auto_retrieve')
        return {
          output: {
            sources: [
              { path: '论文一.pdf' },
              { path: '论文二.pdf' },
              { path: '论文三.pdf' }
            ],
            contextText: '本地知识库返回了数字行政、自动化决策、算法治理与非现场监管论文的正文证据。'
          }
        }
      }),
      define('knowledge_read_file', async (args) => {
        executed.push(`knowledge_read_file:${String(args.path)}`)
        return {
          output: {
            path: args.path,
            content: `这是 ${String(args.path)} 经提取/OCR 后的完整论证摘要，包含规范基础、程序控制与责任分配。`
          }
        }
      }),
      define('data_compliance', async () => {
        executed.push('data_compliance')
        return {
          output: {
            status: 'completed',
            product_type: 'desensitize',
            message: '脱敏完成'
          }
        }
      }),
      define('knowledge_citation_verify', async () => {
        executed.push('knowledge_citation_verify')
        return { output: { verificationPassed: true } }
      }),
      define('document_skill_execute', async (args) => {
        const kind = String(args.kind)
        executed.push(`document_skill_execute:${kind}`)
        return {
          output: {
            status: 'ok',
            kind,
            operation: args.operation,
            output: kind === 'docx'
              ? '/tmp/数字行政法体系建构研究报告.docx'
              : '/tmp/数字行政法体系建构研究报告.pdf'
          }
        }
      })
    ]
    let callIndex = 0
    let citationAttempts = 0
    let readAttempts = 0
    const h = makeHarness({
      provider: 'complex-contract-regression',
      model: 'complex-contract-regression',
      async *stream(request): AsyncIterable<ModelStreamChunk> {
        const required = request.requiredToolName
        if (required === 'knowledge_auto_retrieve') {
          yield {
            kind: 'tool_call_complete',
            callId: `call_complex_${++callIndex}`,
            toolName: required,
            arguments: { query: '数字行政 算法治理 非现场监管' }
          }
        } else if (required === 'knowledge_read_file') {
          const nextPath = ['论文一.pdf', '论文二.pdf', '论文三.pdf'][readAttempts] ?? '论文三.pdf'
          readAttempts += 1
          yield {
            kind: 'tool_call_complete',
            callId: `call_complex_${++callIndex}`,
            toolName: required,
            arguments: { path: nextPath }
          }
        } else if (required === 'data_compliance') {
          yield {
            kind: 'tool_call_complete',
            callId: `call_complex_${++callIndex}`,
            toolName: required,
            arguments: {
              action: 'desensitize',
              mode: 'text',
              text: '张某，身份证号 110101199001011234，手机号 13800138000。'
            }
          }
        } else if (required === 'knowledge_citation_verify') {
          citationAttempts += 1
          yield {
            kind: 'tool_call_complete',
            callId: `call_complex_${++callIndex}`,
            toolName: required,
            arguments: { draft: citationAttempts === 1 ? '# 一、问题的提出\n内容待补充……' : fullDraft }
          }
        } else if (required === 'document_skill_execute') {
          const progress = request.contextInstructions?.join('\n') ?? ''
          const kind = progress.includes('本步仍需生成：DOCX') ? 'docx' : 'pdf'
          yield {
            kind: 'tool_call_complete',
            callId: `call_complex_${++callIndex}`,
            toolName: required,
            arguments: kind === 'docx'
              ? {
                  kind,
                  operation: 'from-markdown',
                  content: fullDraft,
                  outputPath: '数字行政法体系建构研究报告.docx'
                }
              : {
                  kind,
                  operation: 'from-docx',
                  args: [
                    '--input',
                    '数字行政法体系建构研究报告.docx',
                    '--output',
                    '数字行政法体系建构研究报告.pdf'
                  ]
                }
          }
        } else {
          yield { kind: 'assistant_text_delta', text: '全部强制阶段与 Word、PDF 交付均已完成。' }
          yield { kind: 'completed', stopReason: 'stop' }
          return
        }
        yield { kind: 'completed', stopReason: 'tool_calls' }
      }
    }, { tools })
    await bootstrapThread(h, {
      request: {
        prompt: [
          '请先检索本地知识库并对至少 3 篇 PDF 执行 OCR/逐篇研读。',
          '执行脱敏处理演示，分析 2-3 个典型案例。',
          '撰写不少于 600 字的文献综述并交付 Word 与 PDF：',
          '- 一、问题的提出',
          '- 二、规范体系',
          '- 参考文献（标注真实来源）',
          '文件名含「数字行政法体系建构研究报告」，禁止省略号和占位符。'
        ].join('\n')
      }
    })

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const items = await h.sessionStore.loadItems(h.threadId)

    expect(status).toBe('completed')
    expect(executed).toEqual([
      'knowledge_auto_retrieve',
      'knowledge_read_file:论文一.pdf',
      'knowledge_read_file:论文二.pdf',
      'knowledge_read_file:论文三.pdf',
      'data_compliance',
      'knowledge_citation_verify',
      'document_skill_execute:docx',
      'document_skill_execute:pdf'
    ])
    expect(citationAttempts).toBe(2)
    expect(items.some((item) =>
      item.kind === 'tool_result' &&
      item.toolName === 'knowledge_citation_verify' &&
      item.isError === true &&
      JSON.stringify(item.output).includes('explicit_task_contract_failed')
    )).toBe(true)
  })

  it('unlocks the full contract-review pipeline when the active Skill has a legacy restrictive allowlist', async () => {
    const executed: string[] = []
    const define = (
      name: string,
      execute: (args: Record<string, unknown>) => Promise<{ output: unknown; isError?: boolean }>
    ) => LocalToolHost.defineTool({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute
    })
    const tools = [
      define('bash', async () => {
        executed.push('bash')
        return { output: { ok: true } }
      }),
      define('read', async () => ({ output: { ok: true } })),
      define('write', async () => ({ output: { ok: true } })),
      define('edit', async () => ({ output: { ok: true } })),
      define('knowledge_auto_retrieve', async () => {
        executed.push('knowledge_auto_retrieve')
        return {
          output: {
            sources: [{ path: '合同审查思维体系.md' }],
            contextText: '本地合同审查材料涵盖违约责任、知识产权归属、验收标准与争议解决条款的审查方法。'
          }
        }
      }),
      define('knowledge_search', async () => ({ output: { results: [] } })),
      define('knowledge_read_file', async () => ({ output: { content: '本地材料' } })),
      define('mcp_search', async () => {
        executed.push('mcp_search')
        return { output: { results: [{ toolId: 'ima-knowledge-base/research_ima' }] } }
      }),
      define('mcp_call', async () => {
        executed.push('mcp_call')
        return {
          output: {
            serverId: 'ima-knowledge-base',
            toolName: 'research_ima',
            result: 'IMA 返回了软件开发合同审查、违约责任和知识产权归属的知识库证据。'
          }
        }
      }),
      define('document_skill_execute', async (args) => {
        executed.push('document_skill_execute')
        return {
          output: {
            status: 'ok',
            kind: 'docx',
            operation: 'from-markdown',
            output: '/tmp/软件开发合同审查意见书.docx',
            contentBytes: String(args.content ?? '').length
          }
        }
      })
    ]
    const requests: ModelRequest[] = []
    let callIndex = 0
    const h = makeHarness({
      provider: 'contract-review-regression',
      model: 'contract-review-regression',
      async *stream(request): AsyncIterable<ModelStreamChunk> {
        requests.push(request)
        if (request.requiredToolName === 'knowledge_auto_retrieve') {
          yield {
            kind: 'tool_call_complete',
            callId: `call_contract_${++callIndex}`,
            toolName: 'knowledge_auto_retrieve',
            arguments: { question: '软件开发合同审查、违约责任、知识产权归属' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        if (request.requiredToolName === 'document_skill_execute') {
          yield {
            kind: 'tool_call_complete',
            callId: `call_contract_${++callIndex}`,
            toolName: 'document_skill_execute',
            arguments: {
              kind: 'docx',
              operation: 'from-markdown',
              content: '# 软件开发合同审查意见书\n\n'.concat('完整审查意见。'.repeat(1_000)),
              outputPath: '软件开发合同审查意见书.docx'
            }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: '合同审查意见书 Word 已交付。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, {
      tools,
      skillRuntime: {
        resolveTurn: () => ({
          activeSkillIds: ['contract-risk-review'],
          activations: [],
          instructions: ['执行合同风险审查。'],
          // This reproduces the allowlist shipped in the failed trajectories.
          allowedToolNames: ['read', 'write', 'edit', 'bash'],
          injectedBytes: 100
        })
      } as never
    })
    await bootstrapThread(h, {
      request: {
        prompt: [
          '【合同审查任务】请完成一份「软件开发委托合同」的审查意见书，并交付为 Word 文档。',
          '请先检索知识库（本地知识库/IMA）中关于合同审查、软件开发合同、违约责任、知识产权归属的相关材料和法条。',
          '生成 Word 文档（.docx），文件名含「软件开发合同审查意见书」。'
        ].join('\n')
      }
    })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(executed).toEqual([
      'knowledge_auto_retrieve',
      'mcp_search',
      'mcp_call',
      'document_skill_execute'
    ])
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(['knowledge_auto_retrieve'])
    expect(requests.some((request) => request.requiredToolName === 'document_skill_execute')).toBe(true)
    expect(executed).not.toContain('bash')
  })

  it('retrieves local and IMA evidence before handing an exact PPT task to the specialist workflow', async () => {
    const executed: string[] = []
    const define = (
      name: string,
      execute: (args: Record<string, unknown>) => Promise<{ output: unknown; isError?: boolean }>
    ) => LocalToolHost.defineTool({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute
    })
    const tools = [
      define('read', async () => ({ output: { ok: true } })),
      define('write', async () => ({ output: { ok: true } })),
      define('edit', async () => ({ output: { ok: true } })),
      define('bash', async () => {
        executed.push('bash')
        return { output: { status: 'ok', project: '民法典解读.pptd', output: '民法典解读.pptx' } }
      }),
      define('knowledge_auto_retrieve', async () => {
        executed.push('knowledge_auto_retrieve')
        return {
          output: {
            sources: [{ path: '民法典合同编通则司法解释材料.md' }],
            contextText: '本地材料梳理了合同成立、合同效力、履行、解除及违约责任的司法解释要点。'
          }
        }
      }),
      define('mcp_search', async () => {
        executed.push('mcp_search')
        return { output: { results: [{ toolId: 'ima-knowledge-base/research_ima' }] } }
      }),
      define('mcp_call', async () => {
        executed.push('mcp_call')
        return {
          output: {
            serverId: 'ima-knowledge-base',
            toolName: 'research_ima',
            result: 'IMA 返回了民法典合同编通则司法解释的知识库资料与可引用来源。'
          }
        }
      }),
      define('document_skill_execute', async () => {
        executed.push('document_skill_execute')
        return { output: { status: 'ok', kind: 'pptx', operation: 'from-json' } }
      })
    ]
    const requests: ModelRequest[] = []
    let bashCalled = false
    const h = makeHarness({
      provider: 'specialist-ppt-regression',
      model: 'specialist-ppt-regression',
      async *stream(request): AsyncIterable<ModelStreamChunk> {
        requests.push(request)
        if (request.requiredToolName === 'knowledge_auto_retrieve') {
          yield {
            kind: 'tool_call_complete',
            callId: 'call_ppt_local',
            toolName: 'knowledge_auto_retrieve',
            arguments: { question: '民法典合同编通则司法解释要点' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        if (!bashCalled) {
          bashCalled = true
          yield {
            kind: 'tool_call_complete',
            callId: 'call_pptd_export',
            toolName: 'bash',
            arguments: { command: 'build and export the PPTD project' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: 'PPTD 项目和 PPTX 已交付。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, {
      tools,
      skillRuntime: {
        resolveTurn: () => ({
          activeSkillIds: ['open-kimi-ppt'],
          activations: [],
          instructions: ['执行 open-kimi-ppt 的 PPTD 设计、导出和视觉检查流程。'],
          // Simulate another active Skill contributing an overly narrow list.
          allowedToolNames: ['document_skill_execute'],
          injectedBytes: 100
        })
      } as never
    })
    await bootstrapThread(h, {
      request: {
        prompt: [
          '【演示文稿任务】请制作一份 PPT 演示文稿，主题：「民法典合同编通则司法解释要点解读」。',
          '请先检索知识库（本地知识库/IMA）中的相关材料，再基于检索结果制作 PPT。',
          '生成 PPT 演示文稿（.pptx），内容必须完整真实。'
        ].join('\n')
      }
    })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(executed).toEqual(['knowledge_auto_retrieve', 'mcp_search', 'mcp_call', 'bash'])
    const specialistRequests = requests.filter((request) => request.requiredToolName === undefined)
    expect(specialistRequests.length).toBeGreaterThan(0)
    expect(specialistRequests.every((request) =>
      !request.tools.some((tool) => tool.name === 'document_skill_execute')
    )).toBe(true)
    expect(specialistRequests[0]?.tools.map((tool) => tool.name)).toContain('bash')
    expect(specialistRequests[0]?.contextInstructions?.join('\n')).toContain('open-kimi-ppt / PPTD')
    expect(requests.at(-1)?.tools).toEqual([])
  })

  it('recovers an advertised tool call emitted as DeepSeek DSML text', async () => {
    let executions = 0
    const documentTool = LocalToolHost.defineTool({
      name: 'document_skill_execute',
      description: 'create document',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async (args) => {
        executions += 1
        return {
          output: {
            status: 'ok',
            kind: args.kind,
            operation: args.operation,
            output: '/tmp/report.docx'
          }
        }
      }
    })
    let requests = 0
    const h = makeHarness({
      provider: 'dsml-recovery',
      model: 'dsml-recovery',
      async *stream(request): AsyncIterable<ModelStreamChunk> {
        requests += 1
        if (request.requiredToolName) {
          yield {
            kind: 'assistant_text_delta',
            text: [
              '正在生成 Word。',
              '<｜｜DSML｜｜tool_calls>',
              '<｜｜DSML｜｜invoke name="document_skill_execute">',
              '<｜｜DSML｜｜parameter name="kind" string="true">docx</｜｜DSML｜｜parameter>',
              '<｜｜DSML｜｜parameter name="operation" string="true">from-markdown</｜｜DSML｜｜parameter>',
              '</｜｜DSML｜｜invoke>',
              '</｜｜DSML｜｜tool_calls>'
            ].join('\n')
          }
          yield { kind: 'completed', stopReason: 'stop' }
          return
        }
        yield { kind: 'assistant_text_delta', text: 'Word 已生成。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, { tools: [documentTool] })
    await bootstrapThread(h, { request: { prompt: '请生成一份 Word 报告给我' } })

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const items = await h.sessionStore.loadItems(h.threadId)

    expect(status).toBe('completed')
    expect(executions).toBe(1)
    expect(requests).toBe(2)
    expect(items.filter((item) => item.kind === 'assistant_text').map((item) => item.text).join('\n'))
      .not.toContain('DSML')
  })

  it('does not render a false success message before a required tool gate passes', async () => {
    let requests = 0
    const documentTool = LocalToolHost.defineTool({
      name: 'document_skill_execute',
      description: 'create document',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async () => ({ output: { status: 'ok' } })
    })
    const h = makeHarness({
      provider: 'required-tool-prose',
      model: 'required-tool-prose',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        requests += 1
        yield { kind: 'assistant_reasoning_delta', text: '准备完成任务。' }
        yield { kind: 'assistant_text_delta', text: 'Word 已经生成并交付成功。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, { tools: [documentTool] })
    await bootstrapThread(h, { request: { prompt: '请生成一份 Word 报告给我' } })

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const items = await h.sessionStore.loadItems(h.threadId)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)

    expect(status).toBe('failed')
    expect(requests).toBe(3)
    expect(items.some((item) =>
      item.kind === 'assistant_text' && item.text.includes('交付成功')
    )).toBe(false)
    expect(events.some((event) =>
      event.kind === 'assistant_text_delta' || event.kind === 'assistant_reasoning_delta'
    )).toBe(false)
    expect(items.some((item) =>
      item.kind === 'error' && item.code === 'required_tool_missing'
    )).toBe(true)
  })

  it('fails a document turn after three consecutive worker errors instead of looping', async () => {
    let executions = 0
    const documentTool = LocalToolHost.defineTool({
      name: 'document_skill_execute',
      description: 'create document',
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute: async () => {
        executions += 1
        return { output: { status: 'error', error: 'converter unavailable' }, isError: true }
      }
    })
    let calls = 0
    const h = makeHarness({
      provider: 'document-failure-cap',
      model: 'document-failure-cap',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        calls += 1
        yield {
          kind: 'tool_call_complete',
          callId: `call_document_failure_${calls}`,
          toolName: 'document_skill_execute',
          arguments: {
            kind: 'docx',
            operation: 'from-markdown',
            content: '# 报告',
            outputPath: '报告.docx'
          }
        }
        yield { kind: 'completed', stopReason: 'tool_calls' }
      }
    }, { tools: [documentTool] })
    await bootstrapThread(h, { request: { prompt: '请生成一份 Word 报告给我' } })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('failed')
    // The repeat-loop guard suppresses the third identical dispatch; the
    // document state machine then treats that suppression as the third failure.
    expect(executions).toBe(2)
    expect(calls).toBe(3)
  })

  it('blocks document delivery when explicit IMA retrieval exhausts timeout recovery', async () => {
    const executed: string[] = []
    const define = (
      name: string,
      execute: () => Promise<{ output: unknown; isError?: boolean }>
    ) => LocalToolHost.defineTool({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      policy: 'auto',
      execute
    })
    const tools = [
      define('mcp_search', async () => {
        executed.push('mcp_search')
        return { output: { results: [{ toolId: 'ima-knowledge-base/research_ima' }] } }
      }),
      define('mcp_call', async () => {
        executed.push('mcp_call')
        return { output: { error: 'MCP error -32001: Request timed out' }, isError: true }
      }),
      define('document_skill_execute', async () => {
        executed.push('document_skill_execute')
        return {
          output: {
            status: 'ok',
            kind: 'docx',
            operation: 'from-markdown',
            output: '/tmp/ima-timeout-report.docx'
          }
        }
      })
    ]
    let recoveryRequests = 0
    const requests: ModelRequest[] = []
    const h = makeHarness({
      provider: 'ima-bounded-recovery',
      model: 'ima-bounded-recovery',
      async *stream(request): AsyncIterable<ModelStreamChunk> {
        requests.push(request)
        if (request.requiredToolName === 'document_skill_execute') {
          yield {
            kind: 'tool_call_complete',
            callId: 'call_after_ima_timeout',
            toolName: 'document_skill_execute',
            arguments: { kind: 'docx', operation: 'from-markdown' }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        const alreadyDelivered = request.history.some((item) =>
          item.kind === 'tool_result' && item.toolName === 'document_skill_execute' && !item.isError
        )
        if (alreadyDelivered) {
          yield { kind: 'assistant_text_delta', text: 'Word 已交付。' }
          yield { kind: 'completed', stopReason: 'stop' }
          return
        }
        recoveryRequests += 1
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, { tools })
    await bootstrapThread(h, {
      request: { prompt: '请检索 IMA 研究行政处罚并生成 Word 报告' }
    })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(recoveryRequests).toBe(4)
    expect(executed).toEqual(['mcp_search', 'mcp_call'])
    expect(requests.at(-1)?.tools).toEqual([])
    expect(requests.at(-1)?.contextInstructions?.join('\n')).toContain('知识库证据门禁未通过')
  })

  it('keeps running past the legacy eight-step ceiling until the model stops', async () => {
    let calls = 0
    const h = makeHarness(
      {
        provider: 'long-runner',
        model: 'long-runner',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls <= 9) {
            yield {
              kind: 'tool_call_complete',
              callId: `call_ls_${calls}`,
              toolName: 'ls',
              arguments: { path: '.' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'assistant_text_delta', text: 'done' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: buildDefaultLocalTools(), toolStorm: { enabled: false } }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const items = await h.sessionStore.loadItems(h.threadId)

    expect(status).toBe('completed')
    expect(calls).toBe(10)
    expect(items.some((item) => item.kind === 'assistant_text' && item.text === 'done')).toBe(true)
  })

  it('replaces live partial tool results with final tool results in the thread snapshot', async () => {
    const partialTool = LocalToolHost.defineTool({
      name: 'partial_bash',
      description: 'Emit a partial update then a final result',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      policy: 'auto',
      execute: async (_args, _context, onUpdate) => {
        await onUpdate?.({ output: { partial: true }, isError: false })
        return { output: { exit_code: 127 }, isError: true }
      }
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'fake',
        model: 'fake',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_partial',
              toolName: 'partial_bash',
              arguments: {}
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [partialTool] }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const thread = await h.threadStore.get(h.threadId)
    const result = thread?.turns
      .flatMap((turn) => turn.items)
      .find((item) => item.kind === 'tool_result' && item.callId === 'call_partial')

    expect(status).toBe('completed')
    expect(result).toMatchObject({
      kind: 'tool_result',
      status: 'completed',
      isError: true,
      output: { exit_code: 127 }
    })
  })

  it('surfaces tool catalog drift to the UI and next model request', async () => {
    const seenInstructions: string[][] = []
    let modelCalls = 0
    let advertiseExtra = false
    const echoTool = LocalToolHost.defineTool({
      name: 'echo',
      description: 'Echo text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      policy: 'auto',
      execute: async () => {
        advertiseExtra = true
        return { output: { ok: true } }
      }
    })
    const extraTool = LocalToolHost.defineTool({
      name: 'extra_tool',
      description: 'Appears after the first tool call',
      inputSchema: { type: 'object', properties: {}, required: [] },
      policy: 'auto',
      shouldAdvertise: () => advertiseExtra,
      execute: async () => ({ output: { ok: true } })
    })
    const h = makeHarness(
      {
        provider: 'catalog-drift',
        model: 'catalog-drift',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          seenInstructions.push(request.contextInstructions ?? [])
          modelCalls += 1
          if (modelCalls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_echo',
              toolName: 'echo',
              arguments: { text: 'hi' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [echoTool, extraTool] }
    )
    await bootstrapThread(h)

    await h.loop.runTurn(h.threadId, h.turnId)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const items = await h.sessionStore.loadItems(h.threadId)

	    expect(events.some((event) => event.kind === 'tool_catalog_changed')).toBe(true)
	    expect(events.find((event) => event.kind === 'tool_catalog_changed')).toMatchObject({
	      kind: 'tool_catalog_changed',
	      changeKind: 'additive'
	    })
	    expect(items.some((item) => item.kind === 'error' && item.code === 'tool_catalog_changed')).toBe(true)
	    expect(seenInstructions[1]?.some((text) => text.includes('Tool catalog changed'))).toBe(true)
	  })

	  it('stops the turn when an existing tool schema mutates in-place', async () => {
	    let modelCalls = 0
	    const inputSchema: Record<string, unknown> = {
	      type: 'object',
	      properties: { text: { type: 'string' } },
	      required: ['text']
	    }
	    const echoTool = LocalToolHost.defineTool({
	      name: 'echo',
	      description: 'Echo text.',
	      inputSchema,
	      policy: 'auto',
	      execute: async () => {
	        inputSchema.properties = {
	          text: { type: 'string' },
	          unexpected: { type: 'boolean' }
	        }
	        return { output: { ok: true } }
	      }
	    })
	    const h = makeHarness(
	      {
	        provider: 'catalog-breaking-drift',
	        model: 'catalog-breaking-drift',
	        async *stream(): AsyncIterable<ModelStreamChunk> {
	          modelCalls += 1
	          yield {
	            kind: 'tool_call_complete',
	            callId: 'call_echo',
	            toolName: 'echo',
	            arguments: { text: 'hi' }
	          }
	          yield { kind: 'completed', stopReason: 'tool_calls' }
	        }
	      },
	      { tools: [echoTool] }
	    )
	    await bootstrapThread(h)

	    const status = await h.loop.runTurn(h.threadId, h.turnId)
	    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
	    const items = await h.sessionStore.loadItems(h.threadId)

	    expect(status).toBe('completed')
	    expect(modelCalls).toBe(1)
	    expect(events.find((event) => event.kind === 'tool_catalog_changed')).toMatchObject({
	      kind: 'tool_catalog_changed',
	      changeKind: 'breaking'
	    })
	    expect(items.find((item) => item.kind === 'error' && item.code === 'tool_catalog_changed'))
	      .toMatchObject({
	        kind: 'error',
	        message: expect.stringContaining('Legalwork stopped this turn')
	      })
	  })

	  it('runs consecutive built-in read-only tool calls in a deterministic parallel batch', async () => {
    const started: string[] = []
    let resolveBothStarted!: () => void
    let releaseTools!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseTools = resolve
    })
    const makeReadOnlyTool = (name: 'read' | 'grep') =>
      LocalToolHost.defineTool({
        name,
        description: `${name} test tool`,
        inputSchema: {
          type: 'object',
          properties: {}
        },
        policy: 'auto',
        execute: async () => {
          started.push(name)
          if (started.length === 2) resolveBothStarted()
          await release
          return { output: { name } }
        }
      })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'parallel-model',
        model: 'parallel-model',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_read',
              toolName: 'read',
              arguments: {}
            }
            yield {
              kind: 'tool_call_complete',
              callId: 'call_grep',
              toolName: 'grep',
              arguments: {}
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [makeReadOnlyTool('read'), makeReadOnlyTool('grep')] }
    )
    await bootstrapThread(h)

    const run = h.loop.runTurn(h.threadId, h.turnId)
    let startupError: Error | undefined
    try {
      await Promise.race([
        bothStarted,
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`only started ${started.join(',') || 'none'}`)), 100)
        })
      ])
    } catch (error) {
      startupError = error instanceof Error ? error : new Error(String(error))
    } finally {
      releaseTools()
    }
    const status = await run
    if (startupError) throw startupError

    const resultCallIds = (await h.sessionStore.loadItems(h.threadId))
      .filter((item) => item.kind === 'tool_result')
      .map((item) => item.kind === 'tool_result' ? item.callId : '')

    expect(status).toBe('completed')
    expect(started).toEqual(['read', 'grep'])
    expect(resultCallIds).toEqual(['call_read', 'call_grep'])
  })

	  it('repairs wrapped tool arguments before persisting and dispatching calls', async () => {
	    let observedArguments: Record<string, unknown> | null = null
	    let calls = 0
	    const h = makeHarness(
	      {
	        provider: 'wrapped-tool-args',
	        model: 'wrapped-tool-args',
	        async *stream(): AsyncIterable<ModelStreamChunk> {
	          calls += 1
	          if (calls > 1) {
	            yield { kind: 'completed', stopReason: 'stop' }
	            return
	          }
	          yield {
	            kind: 'tool_call_complete',
            callId: 'call_wrapped',
            toolName: 'capture_args',
            arguments: {
              tool_name: 'capture_args',
              arguments: '{"path":"src/main.ts"}'
            }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
        }
      },
      {
        tools: [
          LocalToolHost.defineTool({
            name: 'capture_args',
            description: 'Capture repaired args.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: true },
            policy: 'auto',
            execute: async (args) => {
              observedArguments = { ...args }
              return { output: { ok: true } }
            }
          })
        ]
      }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(observedArguments).toEqual({ path: 'src/main.ts' })
    const items = await h.sessionStore.loadItems(h.threadId)
    const toolCall = items.find((item) => item.kind === 'tool_call' && item.callId === 'call_wrapped')
    expect(toolCall).toMatchObject({
      arguments: { path: 'src/main.ts' },
      summary: expect.stringContaining('flattened arguments wrapper')
    })
  })

	  it('suppresses repeated identical tool calls within a turn', async () => {
	    let executions = 0
    const echoTool = LocalToolHost.defineTool({
      name: 'echo',
      description: 'Echo text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      policy: 'auto',
      execute: async () => {
        executions += 1
        return { output: { ok: executions } }
      }
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'storm-model',
        model: 'storm-model',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls <= 3) {
            yield {
              kind: 'tool_call_complete',
              callId: `call_echo_${calls}`,
              toolName: 'echo',
              arguments: { text: 'repeat me' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [echoTool] }
    )
    await bootstrapThread(h)

	    const status = await h.loop.runTurn(h.threadId, h.turnId)
	    const items = await h.sessionStore.loadItems(h.threadId)
	    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
	    const stormResult = items.find(
	      (item) => item.kind === 'tool_result' && item.callId === 'call_echo_3'
	    )
    const thirdCall = items.find(
      (item) => item.kind === 'tool_call' && item.callId === 'call_echo_3'
    )

    expect(status).toBe('completed')
    expect(executions).toBe(2)
    expect(thirdCall).toMatchObject({ kind: 'tool_call', status: 'failed' })
	    expect(stormResult?.kind === 'tool_result' ? stormResult.isError : false).toBe(true)
	    expect(stormResult?.kind === 'tool_result' ? JSON.stringify(stormResult.output) : '')
	      .toContain('repeat-loop guard suppressed')
	    expect(events.find((event) => event.kind === 'tool_storm_suppressed')).toMatchObject({
	      kind: 'tool_storm_suppressed',
	      callId: 'call_echo_3',
	      toolName: 'echo'
	    })
	  })

	  it('can disable the storm breaker through loop config', async () => {
	    let executions = 0
	    const echoTool = LocalToolHost.defineTool({
	      name: 'echo',
	      description: 'Echo text',
	      inputSchema: {
	        type: 'object',
	        properties: { text: { type: 'string' } },
	        required: ['text']
	      },
	      policy: 'auto',
	      execute: async () => {
	        executions += 1
	        return { output: { ok: executions } }
	      }
	    })
	    let calls = 0
	    const h = makeHarness(
	      {
	        provider: 'storm-disabled-model',
	        model: 'storm-disabled-model',
	        async *stream(): AsyncIterable<ModelStreamChunk> {
	          calls += 1
	          if (calls <= 3) {
	            yield {
	              kind: 'tool_call_complete',
	              callId: `call_echo_${calls}`,
	              toolName: 'echo',
	              arguments: { text: 'repeat me' }
	            }
	            yield { kind: 'completed', stopReason: 'tool_calls' }
	            return
	          }
	          yield { kind: 'completed', stopReason: 'stop' }
	        }
	      },
	      { tools: [echoTool], toolStorm: { enabled: false } }
	    )
	    await bootstrapThread(h)

	    const status = await h.loop.runTurn(h.threadId, h.turnId)
	    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)

	    expect(status).toBe('completed')
	    expect(executions).toBe(3)
	    expect(events.some((event) => event.kind === 'tool_storm_suppressed')).toBe(false)
	  })

	  it('uses compact tool history for model requests without mutating persisted results', async () => {
    const longOutput = Array.from({ length: 600 }, (_, index) =>
      index === 320 ? 'ERROR auth middleware failed hard' : `plain output line ${index}`
    ).join('\n')
    const observedRequests: ModelRequest[] = []
    const bashTool = LocalToolHost.defineTool({
      name: 'bash',
      description: 'Execute command',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      },
      policy: 'auto',
      execute: async () => ({
        output: {
          command: 'npm test',
          cwd: '/tmp',
          exit_code: 1,
          output: longOutput,
          full_output_path: '/tmp/full-output.log'
        },
        isError: true
      })
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'capture',
        model: 'capture',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          observedRequests.push(request)
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_bash',
              toolName: 'bash',
              arguments: { command: 'npm test' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        tools: [bashTool],
        compactor: new ContextCompactor({ softThreshold: 1_000_000, hardThreshold: 1_100_000 }),
        tokenEconomy: { enabled: true }
      }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const persisted = (await h.sessionStore.loadItems(h.threadId)).find((item) => item.kind === 'tool_result')
    const secondRequestResult = observedRequests[1]?.history.find((item) => item.kind === 'tool_result')
    const usageEvents = (await h.sessionStore.loadEventsSince(h.threadId, 0))
      .filter((event) => event.kind === 'usage')

    expect(status).toBe('completed')
    expect(persisted?.kind === 'tool_result' ? JSON.stringify(persisted.output) : '').toContain('plain output line 599')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output) : '').not.toContain('plain output line 300')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output).length : 0)
      .toBeLessThan(JSON.stringify(persisted?.kind === 'tool_result' ? persisted.output : '').length)
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output) : '').toContain('token economy')
    expect(usageEvents.some((event) =>
      event.kind === 'usage' && (event.usage.tokenEconomySavingsTokens ?? 0) > 0
    )).toBe(true)
  })

  it('bounds tool history for model requests even when token economy is disabled', async () => {
    const longOutput = Array.from({ length: 700 }, (_, index) =>
      index === 350 ? 'ERROR default history hygiene caught this line' : `verbose output line ${index}`
    ).join('\n')
    const observedRequests: ModelRequest[] = []
    const bashTool = LocalToolHost.defineTool({
      name: 'bash',
      description: 'Execute command',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      },
      policy: 'auto',
      execute: async () => ({
        output: {
          command: 'npm test',
          output: longOutput
        },
        isError: true
      })
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'capture',
        model: 'capture',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          observedRequests.push(request)
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_bash',
              toolName: 'bash',
              arguments: { command: 'npm test', transcript: 'x'.repeat(12_000) }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        tools: [bashTool],
        compactor: new ContextCompactor({ softThreshold: 1_000_000, hardThreshold: 1_100_000 })
      }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const persisted = (await h.sessionStore.loadItems(h.threadId)).find((item) => item.kind === 'tool_result')
    const secondRequestCall = observedRequests[1]?.history.find((item) => item.kind === 'tool_call')
    const secondRequestResult = observedRequests[1]?.history.find((item) => item.kind === 'tool_result')

    expect(status).toBe('completed')
    expect(persisted?.kind === 'tool_result' ? JSON.stringify(persisted.output) : '').toContain('verbose output line 699')
    expect(secondRequestCall?.kind === 'tool_call' ? String(secondRequestCall.arguments.transcript) : '')
      .toContain('cache hygiene')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output) : '')
      .toContain('ERROR default history hygiene caught this line')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output) : '')
      .toContain('verbose output line 699')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output) : '')
      .toContain('cache hygiene')
    expect(secondRequestResult?.kind === 'tool_result' ? JSON.stringify(secondRequestResult.output).length : 0)
      .toBeLessThan(JSON.stringify(persisted?.kind === 'tool_result' ? persisted.output : '').length)
  })

  it('uses per-turn model from startTurn request', async () => {
    let seenModel = ''
    const h = makeHarness({
      provider: 'selector',
      model: 'fallback',
      async *stream({ model }: ModelRequest): AsyncIterable<ModelStreamChunk> {
        seenModel = model
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await h.threadStore.upsert(
      createThreadRecord({
        id: h.threadId,
        title: 'demo',
        workspace: '/tmp',
        model: 'thread-model'
      })
    )
    const { turnId } = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'hello', model: 'deepseek-v4-pro' }
    })
    const status = await h.loop.runTurn(h.threadId, turnId)
    const thread = await h.threadStore.get(h.threadId)
    expect(status).toBe('completed')
    expect(seenModel).toBe('deepseek-v4-pro')
    expect(thread?.turns.find((turn) => turn.id === turnId)?.model).toBe('deepseek-v4-pro')
  })

  it('propagates partial tool updates through item_updated before final completion', async () => {
    const streamingTool = LocalToolHost.defineTool({
      name: 'streamer',
      description: 'stream',
      inputSchema: { type: 'object', properties: {}, required: [] },
      policy: 'auto',
      execute: async (_args, _context, onUpdate) => {
        await onUpdate?.({ output: { partial: 'hello' } })
        return { output: { done: true } }
      }
    })
    let calls = 0
    const h = makeHarness({
      provider: 'partial-update',
      model: 'partial-update',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        calls += 1
        if (calls === 1) {
          yield {
            kind: 'tool_call_complete',
            callId: 'call_streamer',
            toolName: 'streamer',
            arguments: {}
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, { tools: [streamingTool] })
    await bootstrapThread(h)
    const status = await h.loop.runTurn(h.threadId, h.turnId)
    expect(status).toBe('completed')
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const partialUpdate = events.find(
      (event) =>
        (event.kind === 'item_created' || event.kind === 'item_updated') &&
        event.item.kind === 'tool_result' &&
        (event.item.output as { partial?: string }).partial === 'hello'
    )
    expect(partialUpdate).toBeDefined()
    const result = (await h.sessionStore.loadItems(h.threadId)).find(
      (item) => item.kind === 'tool_result' && item.callId === 'call_streamer'
    )
    expect(result).toMatchObject({
      kind: 'tool_result',
      status: 'completed',
      output: { done: true }
    })
  })

  it('waits for GUI user input tool responses and resumes the turn', async () => {
    let calls = 0
    const h = makeHarness({
      provider: 'input-model',
      model: 'input-model',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        calls += 1
        if (calls === 1) {
          yield {
            kind: 'tool_call_complete',
            callId: 'call_input',
            toolName: 'request_user_input',
            arguments: {
              prompt: 'Pick one',
              questions: [
                {
                  header: 'Decision',
                  id: 'choice',
                  question: 'Pick one',
                  options: [
                    { label: 'Yes', description: 'Continue' },
                    { label: 'No', description: 'Stop' }
                  ]
                }
              ]
            }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await bootstrapThread(h)
    const resolver = resolveNextUserInput(h, [
      { id: 'choice', label: 'Yes', value: 'yes' }
    ])

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    await resolver

    expect(status).toBe('completed')
    const thread = await h.threadStore.get(h.threadId)
    const inputItem = thread?.turns
      .flatMap((turn) => turn.items)
      .find((item) => item.kind === 'user_input')
    expect(inputItem).toMatchObject({
      kind: 'user_input',
      status: 'submitted',
      questions: [
        {
          header: 'Decision',
          id: 'choice',
          question: 'Pick one',
          options: [
            { label: 'Yes', description: 'Continue' },
            { label: 'No', description: 'Stop' }
          ]
        }
      ]
    })
    const result = (await h.sessionStore.loadItems(h.threadId)).find((item) => item.kind === 'tool_result')
    expect(result).toMatchObject({
      kind: 'tool_result',
      toolName: 'request_user_input',
      isError: false
    })
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    expect(events.some((event) => event.kind === 'user_input_requested')).toBe(true)
    expect(events.some((event) => event.kind === 'user_input_resolved')).toBe(true)
  })

  it('uses the thread approval policy when executing auto tools', async () => {
    const approvalDecisions: string[] = []
    const tool = LocalToolHost.defineTool({
      name: 'dangerous_auto',
      description: 'Auto tool that should still prompt in untrusted mode.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      policy: 'auto',
      execute: async (args) => ({ output: { echoed: args.text ?? '' } })
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'approval-check',
        model: 'approval-check',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_danger',
              toolName: 'dangerous_auto',
              arguments: { text: 'hi' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [tool] }
    )
    await h.threadStore.upsert(
      createThreadRecord({
        id: h.threadId,
        title: 'demo',
        workspace: '/tmp',
        model: 'fake',
        approvalPolicy: 'untrusted'
      })
    )
    const response = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'hello' }
    })
    h.turnId = response.turnId
    h.approvalGate.request = async (approval) => {
      approvalDecisions.push(approval.toolName)
      return 'allow'
    }

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(approvalDecisions).toEqual(['dangerous_auto'])
  })

  it('persists toolKind from the advertised tool metadata', async () => {
    const tool = LocalToolHost.defineTool({
      name: 'write_file',
      description: 'Write a file.',
      toolKind: 'file_change',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      },
      policy: 'auto',
      execute: async () => ({ output: { path: '/tmp/demo.ts' } })
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'file-tool',
        model: 'file-tool',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_file',
              toolName: 'write_file',
              arguments: { path: '/tmp/demo.ts' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [tool] }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const items = await h.sessionStore.loadItems(h.threadId)
    const toolCall = items.find((item) => item.kind === 'tool_call')
    const toolResult = items.find((item) => item.kind === 'tool_result')

    expect(status).toBe('completed')
    expect(toolCall).toMatchObject({ kind: 'tool_call', toolKind: 'file_change' })
    expect(toolResult).toMatchObject({ kind: 'tool_result', toolKind: 'file_change' })
  })

  it('records non-advertised tool calls as recoverable tool errors', async () => {
    let calls = 0
    const h = makeHarness(
      {
        provider: 'policy-recovery',
        model: 'policy-recovery',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_read',
              toolName: 'read',
              arguments: { path: 'draft.md' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'assistant_text_delta', text: '继续使用已开放工具。' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        tools: buildDefaultLocalTools(),
        skillRuntime: {
          resolveTurn: () => ({
            activeSkillIds: ['knowledge-only'],
            activations: [],
            instructions: [],
            allowedToolNames: ['bash'],
            injectedBytes: 0
          })
        } as never
      }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(calls).toBe(2)
    const result = (await h.sessionStore.loadItems(h.threadId)).find(
      (item) => item.kind === 'tool_result' && item.callId === 'call_read'
    )
    expect(result).toMatchObject({ kind: 'tool_result', isError: true, toolName: 'read' })
    expect(result?.kind === 'tool_result' ? JSON.stringify(result.output) : '')
      .toContain('not advertised by active tool policy')
  })

  it('omits create_plan from normal agent model requests', async () => {
    const observedTools: string[] = []
    const h = makeHarness(
      {
        provider: 'capture',
        model: 'capture',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          observedTools.push(...request.tools.map((tool) => tool.name))
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: buildDefaultLocalTools() }
    )
    await bootstrapThread(h)
    await h.loop.runTurn(h.threadId, h.turnId)
    expect(observedTools).not.toContain(CREATE_PLAN_TOOL_NAME)
  })

  it('injects active goal guidance and goal status tools into model requests', async () => {
    const observedRequests: ModelRequest[] = []
    const goalTools = [GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME].map((name) =>
      LocalToolHost.defineTool({
        name,
        description: name,
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        },
        policy: 'auto',
        execute: async () => ({ output: { ok: true } })
      })
    )
    const h = makeHarness(
      {
        provider: 'capture-goal',
        model: 'capture-goal',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          observedRequests.push(request)
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [...buildDefaultLocalTools(), ...goalTools] }
    )
    await bootstrapThread(h, { request: { prompt: 'check current memory usage' } })
    await h.threads.setGoal(h.threadId, {
      objective: 'check current memory usage',
      status: 'active'
    })

    await h.loop.runTurn(h.threadId, h.turnId)

    const [request] = observedRequests
    if (!request) throw new Error('expected model request')
    expect(request.contextInstructions?.join('\n')).toContain('继续推进当前任务目标。')
    expect(request.contextInstructions?.join('\n')).toContain('内部思考、工具决策和进度说明均默认使用简体中文。')
    expect(request.contextInstructions?.join('\n')).toContain('check current memory usage')
    expect(request.tools.map((tool) => tool.name)).toContain(GET_GOAL_TOOL_NAME)
    expect(request.tools.map((tool) => tool.name)).toContain(UPDATE_GOAL_TOOL_NAME)
  })

  it('continues an active goal after no-tool model turns until update_goal completes it', async () => {
    let h: ReturnType<typeof makeHarness>
    const goalTools = [
      LocalToolHost.defineTool({
        name: GET_GOAL_TOOL_NAME,
        description: 'Get goal',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        },
        policy: 'auto',
        execute: async (_args, context) => ({ output: { goal: await h.threads.getGoal(context.threadId) } })
      }),
      LocalToolHost.defineTool({
        name: UPDATE_GOAL_TOOL_NAME,
        description: 'Update goal',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['complete', 'blocked'] }
          },
          required: ['status'],
          additionalProperties: false
        },
        policy: 'auto',
        execute: async (args, context) => {
          const status = args.status
          if (status !== 'complete' && status !== 'blocked') {
            return { output: { error: 'invalid status' }, isError: true }
          }
          const goal = await h.threads.setGoal(context.threadId, { status })
          return { output: { goal } }
        }
      })
    ]
    let calls = 0
    h = makeHarness(
      {
        provider: 'goal-continuation',
        model: 'goal-continuation',
        async *stream(): AsyncIterable<ModelStreamChunk> {
          calls += 1
          if (calls === 1) {
            yield { kind: 'assistant_text_delta', text: 'Draft ready.' }
            yield { kind: 'completed', stopReason: 'stop' }
            return
          }
          if (calls === 2) {
            yield { kind: 'assistant_text_delta', text: 'Still working.' }
            yield { kind: 'completed', stopReason: 'stop' }
            return
          }
          if (calls === 3) {
            yield {
              kind: 'tool_call_complete',
              callId: 'call_complete_goal',
              toolName: UPDATE_GOAL_TOOL_NAME,
              arguments: { status: 'complete' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'assistant_text_delta', text: 'Goal complete.' }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      { tools: [...buildDefaultLocalTools(), ...goalTools] }
    )
    await bootstrapThread(h, { request: { prompt: 'write a benchmark note' } })
    await h.threads.setGoal(h.threadId, {
      objective: 'write a benchmark note',
      status: 'active'
    })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(calls).toBe(4)
    expect((await h.threads.getGoal(h.threadId))?.status).toBe('complete')
    const texts = (await h.sessionStore.loadItems(h.threadId))
      .filter((item) => item.kind === 'assistant_text')
      .map((item) => item.kind === 'assistant_text' ? item.text : '')
    expect(texts).toEqual(['Draft ready.', 'Still working.', 'Goal complete.'])
  })

  it('persists the canonical tool catalog fingerprint on each turn', async () => {
    const h = makeHarness(makeSilentModel(), { tools: buildDefaultLocalTools() })
    await bootstrapThread(h)

    await h.loop.runTurn(h.threadId, h.turnId)

    const turn = await h.turns.getTurn(h.threadId, h.turnId)
    expect(turn?.toolCatalogFingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(turn?.toolCatalogToolCount).toBeGreaterThan(0)
    expect(turn?.toolCatalogDrift).toBe(false)
  })

  it('uses persisted GUI plan context to advertise and execute create_plan', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'legalwork-loop-plan-'))
    const observedToolLists: string[][] = []
    const observedRequiredToolNames: Array<string | undefined> = []
    try {
      const h = makeHarness(
        {
          provider: 'planner',
          model: 'planner',
          async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
            observedToolLists.push(request.tools.map((tool) => tool.name))
            observedRequiredToolNames.push(request.requiredToolName)
            if (observedToolLists.length === 1) {
              yield {
                kind: 'tool_call_complete',
                callId: 'call_plan',
                toolName: CREATE_PLAN_TOOL_NAME,
                arguments: {
                  markdown: '# Generated plan',
                  operation: 'draft',
                  source_request: 'Add auth'
                }
              }
              yield { kind: 'completed', stopReason: 'tool_calls' }
              return
            }
            yield { kind: 'completed', stopReason: 'stop' }
          }
        },
        { tools: buildDefaultLocalTools() }
      )
      await bootstrapThread(h, {
        workspace,
        request: {
          prompt: 'Plan auth',
          guiPlan: {
            operation: 'draft',
            workspaceRoot: workspace,
            relativePath: '.legalworksdd/plan/auth.md',
            planId: `${workspace}:.legalworksdd/plan/auth.md`,
            sourceRequest: 'Add auth',
            title: 'Auth'
          }
        }
      })
      const status = await h.loop.runTurn(h.threadId, h.turnId)
      expect(status).toBe('completed')
      expect(observedToolLists[0]).toContain(CREATE_PLAN_TOOL_NAME)
      expect(observedRequiredToolNames).toEqual([CREATE_PLAN_TOOL_NAME, undefined])
      await expect(readFile(join(workspace, '.legalworksdd/plan/auth.md'), 'utf8')).resolves.toBe('# Generated plan')
      const turn = await h.turns.getTurn(h.threadId, h.turnId)
      expect(turn?.guiPlan?.relativePath).toBe('.legalworksdd/plan/auth.md')
      const items = await h.sessionStore.loadItems(h.threadId)
      const result = items.find((item) => item.kind === 'tool_result' && item.callId === 'call_plan')
      expect(result).toBeDefined()
      if (result?.kind === 'tool_result') {
        expect(result.toolName).toBe(CREATE_PLAN_TOOL_NAME)
        expect(result.output).toMatchObject({
          relative_path: '.legalworksdd/plan/auth.md',
          workspace_root: workspace,
          operation: 'draft'
        })
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('materializes assistant plan text when a GUI plan turn misses create_plan', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'legalwork-loop-plan-missing-tool-'))
    try {
      const h = makeHarness(
        {
          provider: 'planner',
          model: 'planner',
          async *stream(): AsyncIterable<ModelStreamChunk> {
            yield { kind: 'assistant_text_delta', text: '## Plan\nImplement auth.\n' }
            yield { kind: 'completed', stopReason: 'stop' }
          }
        },
        { tools: buildDefaultLocalTools() }
      )
      await bootstrapThread(h, {
        workspace,
        request: {
          prompt: 'Plan auth',
          guiPlan: {
            operation: 'draft',
            workspaceRoot: workspace,
            relativePath: '.legalworksdd/plan/auth.md',
            planId: `${workspace}:.legalworksdd/plan/auth.md`,
            sourceRequest: 'Add auth'
          }
        }
      })

      const status = await h.loop.runTurn(h.threadId, h.turnId)
      const items = await h.sessionStore.loadItems(h.threadId)

      expect(status).toBe('completed')
      await expect(readFile(join(workspace, '.legalworksdd/plan/auth.md'), 'utf8')).resolves.toBe(
        '## Plan\nImplement auth.'
      )
      expect(items.some((item) =>
        item.kind === 'tool_result' &&
        item.toolName === CREATE_PLAN_TOOL_NAME &&
        item.isError !== true
      )).toBe(true)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('materializes assistant plan text for plan-mode turns without a reserved context', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'legalwork-loop-plan-free-form-text-'))
    try {
      const h = makeHarness(
        {
          provider: 'planner',
          model: 'planner',
          async *stream(): AsyncIterable<ModelStreamChunk> {
            yield { kind: 'assistant_text_delta', text: '## Plan\nPolish the sidebar footer.\n' }
            yield { kind: 'completed', stopReason: 'stop' }
          }
        },
        { tools: buildDefaultLocalTools() }
      )
      await bootstrapThread(h, {
        workspace,
        request: {
          prompt: 'Plan sidebar footer polish',
          mode: 'plan'
        }
      })

      const status = await h.loop.runTurn(h.threadId, h.turnId)
      const items = await h.sessionStore.loadItems(h.threadId)
      const planResult = items.find((item) =>
        item.kind === 'tool_result' && item.toolName === CREATE_PLAN_TOOL_NAME
      )

      expect(status).toBe('completed')
      expect(planResult?.kind === 'tool_result' && planResult.isError).not.toBe(true)
      expect(
        planResult?.kind === 'tool_result' &&
        (planResult.output as { relative_path?: string }).relative_path
      ).toBe('.legalworksdd/plan/plan-sidebar-footer-polish.md')
      await expect(readFile(join(workspace, '.legalworksdd/plan/plan-sidebar-footer-polish.md'), 'utf8')).resolves.toBe(
        '## Plan\nPolish the sidebar footer.'
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('fails GUI plan turns only when neither create_plan nor plan text is returned', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'legalwork-loop-plan-empty-'))
    try {
      const h = makeHarness(
        {
          provider: 'planner',
          model: 'planner',
          async *stream(): AsyncIterable<ModelStreamChunk> {
            yield { kind: 'completed', stopReason: 'stop' }
          }
        },
        { tools: buildDefaultLocalTools() }
      )
      await bootstrapThread(h, {
        workspace,
        request: {
          prompt: 'Plan auth',
          guiPlan: {
            operation: 'draft',
            workspaceRoot: workspace,
            relativePath: '.legalworksdd/plan/auth.md',
            planId: `${workspace}:.legalworksdd/plan/auth.md`,
            sourceRequest: 'Add auth'
          }
        }
      })

      const status = await h.loop.runTurn(h.threadId, h.turnId)
      const items = await h.sessionStore.loadItems(h.threadId)
      const events = await h.sessionStore.loadEventsSince(h.threadId, 0)

      expect(status).toBe('failed')
      expect(items.some((item) =>
        item.kind === 'error' && item.code === 'required_tool_missing'
      )).toBe(true)
      expect(events.some((event) =>
        event.kind === 'error' && event.code === 'required_tool_missing'
      )).toBe(true)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('keeps requiring create_plan after unrelated tool calls in a GUI plan turn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'legalwork-loop-plan-other-tool-'))
    const observedRequiredToolNames: Array<string | undefined> = []
    let calls = 0
    try {
      const h = makeHarness(
        {
          provider: 'planner',
          model: 'planner',
          async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
            observedRequiredToolNames.push(request.requiredToolName)
            calls += 1
            if (calls === 1) {
              yield {
                kind: 'tool_call_complete',
                callId: 'call_echo',
                toolName: 'echo',
                arguments: { text: 'not a plan' }
              }
              yield { kind: 'completed', stopReason: 'tool_calls' }
              return
            }
            yield { kind: 'assistant_text_delta', text: '## Plan\nImplement auth after checking context.\n' }
            yield { kind: 'completed', stopReason: 'stop' }
          }
        },
        { tools: buildDefaultLocalTools() }
      )
      await bootstrapThread(h, {
        workspace,
        request: {
          prompt: 'Plan auth',
          guiPlan: {
            operation: 'draft',
            workspaceRoot: workspace,
            relativePath: '.legalworksdd/plan/auth.md',
            planId: `${workspace}:.legalworksdd/plan/auth.md`,
            sourceRequest: 'Add auth'
          }
        }
      })

      const status = await h.loop.runTurn(h.threadId, h.turnId)

      expect(status).toBe('completed')
      expect(observedRequiredToolNames).toEqual([CREATE_PLAN_TOOL_NAME, CREATE_PLAN_TOOL_NAME, undefined])
      await expect(readFile(join(workspace, '.legalworksdd/plan/auth.md'), 'utf8')).resolves.toBe(
        '## Plan\nImplement auth after checking context.'
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('steers the turn and injects user messages', async () => {
    const h = makeHarness(makeSilentModel())
    await bootstrapThread(h)
    h.steering.enqueue(h.turnId, 'follow up')
    await h.loop.runTurn(h.threadId, h.turnId)
    const items = await h.sessionStore.loadItems(h.threadId)
    const user = items.find((item) => item.kind === 'user_message' && item.text === 'follow up')
    expect(user).toBeDefined()
  })

  it('cleans up inflight ids after success and error', async () => {
    const h = makeHarness({
      provider: 'flaky',
      model: 'flaky',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        yield { kind: 'error', message: 'boom' }
        yield { kind: 'completed', stopReason: 'error' }
      }
    })
    await bootstrapThread(h)
    await h.loop.runTurn(h.threadId, h.turnId)
    expect(h.inflight.size()).toBe(0)
  })

  it('keeps the prefix stable when the system prompt does not change', () => {
    const a = createImmutablePrefix({ systemPrompt: 'be brief' })
    const b = createImmutablePrefix({ systemPrompt: 'be brief' })
    expect(a.fingerprint).toBe(b.fingerprint)
    const drifted = setSystemPrompt(a, 'be thorough')
    expect(drifted.fingerprint).not.toBe(a.fingerprint)
  })

  it('keeps a 1M context window but compacts DeepSeek history well below it', () => {
    const compactor = new ContextCompactor()
    // ~110K tokens (charsPerToken=4); above the 100K soft threshold.
    const longItems = [
      makeUserItem({
        id: 'long_history',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'x'.repeat(440_000)
      })
    ]
    // ~20K tokens; below the 100K soft threshold — ordinary turns stay uncompacted.
    const moderateItems = [
      makeUserItem({
        id: 'moderate_history',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'x'.repeat(80_000)
      })
    ]
    // ~60K tokens; would have compacted under the old 40K threshold but stays
    // uncompacted now that soft=100K, cutting compaction-driven cache clears.
    const midItems = [
      makeUserItem({
        id: 'mid_history',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'x'.repeat(240_000)
      })
    ]

    expect(resolveModelContextProfile('deepseek-v4-pro')?.contextWindowTokens).toBe(1_000_000)
    expect(resolveModelContextProfile('provider/deepseek-v4-flash')?.contextWindowTokens).toBe(1_000_000)
    expect(resolveModelContextProfile('deepseek-chat')?.canonicalModel).toBe('deepseek-v4-flash')
    expect(resolveModelContextProfile('deepseek-reasoner')?.canonicalModel).toBe('deepseek-v4-flash')
    // Long history (110K tokens) still compacts for DeepSeek — well below the 1M
    // context window — so runaway re-billing stays bounded.
    expect(compactor.shouldCompact(longItems, { model: 'deepseek-v4-pro' })).toBe(true)
    expect(compactor.shouldCompact(longItems, { model: 'deepseek-v4-flash' })).toBe(true)
    // Moderate (20K) and mid (60K) history stay uncompacted to avoid churn.
    expect(compactor.shouldCompact(moderateItems, { model: 'deepseek-v4-flash' })).toBe(false)
    expect(compactor.shouldCompact(midItems, { model: 'deepseek-v4-flash' })).toBe(false)
    expect(compactor.hardCap('deepseek-v4-flash')).toBe(130_000)
  })

  it('uses reported prompt tokens as a compaction pressure signal', () => {
    const compactor = new ContextCompactor({ softThreshold: 100, hardThreshold: 200 })
    const tinyHistory = [
      makeUserItem({
        id: 'tiny_history',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'short'
      })
    ]

    expect(compactor.shouldCompact(tinyHistory)).toBe(false)
    expect(compactor.shouldCompact(tinyHistory, { promptTokens: 120 })).toBe(true)
  })

  it('plans normal, aggressive, and force compaction levels', () => {
    const compactor = new ContextCompactor({ softThreshold: 100, hardThreshold: 200 })
    const tinyHistory = [
      makeUserItem({
        id: 'tiny_history',
        turnId: 'turn_1',
        threadId: 'thr_1',
        text: 'short'
      })
    ]

    expect(compactor.planCompaction(tinyHistory, { promptTokens: 120 })).toMatchObject({
      mode: 'normal',
      keepRecent: 4
    })
    expect(compactor.planCompaction(tinyHistory, { promptTokens: 160 })).toMatchObject({
      mode: 'aggressive',
      keepRecent: 2
    })
    expect(compactor.planCompaction(tinyHistory, { promptTokens: 220 })).toMatchObject({
      mode: 'force',
      keepRecent: 1
    })
  })

  it('trims trailing tool calls and preserves skill pins in compaction summaries', () => {
    const compactor = new ContextCompactor({ softThreshold: 1, hardThreshold: 2 })
    const prefix = createImmutablePrefix({ systemPrompt: 'system' })
    const result = compactor.compact({
      threadId: 'thr_1',
      turnId: 'turn_1',
      prefix,
      keepRecent: 1,
      history: [
        makeUserItem({ id: 'u1', turnId: 'turn_1', threadId: 'thr_1', text: 'first request' }),
        makeAssistantTextItem({
          id: 'a1',
          turnId: 'turn_1',
          threadId: 'thr_1',
          text: 'Active Skill: documents (documents)',
          status: 'completed'
        }),
        makeToolCallItem({
          id: 'call_trailing',
          turnId: 'turn_1',
          threadId: 'thr_1',
          callId: 'call_trailing',
          toolName: 'read',
          arguments: { path: 'a.txt' }
        })
      ]
    })

    expect(result.next.some((item) => item.kind === 'tool_call')).toBe(false)
    expect(result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : '')
      .toContain('Active Skill: documents (documents)')
  })

  it('embeds a digest marker and skips frozen messages when compacting history', () => {
    const compactor = new ContextCompactor({ softThreshold: 1, hardThreshold: 2 })
    const prefix = createImmutablePrefix({ systemPrompt: 'system' })
    const result = compactor.compact({
      threadId: 'thr_1',
      turnId: 'turn_1',
      prefix,
      keepRecent: 1,
      frozenMessageCount: 1,
      history: [
        makeUserItem({ id: 'frozen', turnId: 'turn_1', threadId: 'thr_1', text: 'already processed upstream' }),
        makeUserItem({ id: 'u1', turnId: 'turn_1', threadId: 'thr_1', text: 'fold alpha' }),
        makeAssistantTextItem({
          id: 'a1',
          turnId: 'turn_1',
          threadId: 'thr_1',
          text: 'fold beta',
          status: 'completed'
        }),
        makeUserItem({ id: 'u2', turnId: 'turn_1', threadId: 'thr_1', text: 'keep gamma' })
      ]
    })
    const summary = result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : ''

    expect(result.next.map((item) => item.id)).toEqual(['frozen', result.summaryItem.id, 'u2'])
    expect(summary).toContain('fold alpha')
    expect(summary).not.toContain('already processed upstream')
    expect(result.summaryItem.kind === 'compaction' ? result.summaryItem.sourceDigest : '')
      .toMatch(/^[0-9a-f]{16}$/)
    expect(result.summaryItem.kind === 'compaction' ? result.summaryItem.digestMarker : '')
      .toBe(`<legalwork:tool_digest sha256="${result.summaryItem.kind === 'compaction' ? result.summaryItem.sourceDigest : ''}">`)
    expect(result.summaryItem.kind === 'compaction' ? result.summaryItem.sourceItemIds : [])
      .toEqual(['u1', 'a1'])
    expect(summary).toContain(result.summaryItem.kind === 'compaction' ? result.summaryItem.digestMarker : '')
  })

  it('accepts configured context compaction thresholds and model profiles', () => {
    const compactor = new ContextCompactor({
      contextCompaction: {
        defaultSoftThreshold: 123,
        defaultHardThreshold: 456,
        modelProfiles: {
          'custom-model': {
            aliases: ['vendor/custom-model'],
            softThreshold: 1_000,
            hardThreshold: 2_000
          }
        }
      }
    })

    expect(compactor.thresholds()).toEqual({ softThreshold: 123, hardThreshold: 456 })
    expect(compactor.thresholds('vendor/custom-model')).toEqual({
      softThreshold: 1_000,
      hardThreshold: 2_000
    })
  })

  it('compacts the history when the soft threshold is reached', async () => {
    const h = makeHarness(makeSilentModel(), {
      compactor: new ContextCompactor({ softThreshold: 8, hardThreshold: 16 })
    })
    await bootstrapThread(h)
    for (let i = 0; i < 10; i += 1) {
      await h.sessionStore.appendItem(
        h.threadId,
        makeUserItem({ id: `hist_${i}`, turnId: h.turnId, threadId: h.threadId, text: 'x'.repeat(20) })
      )
    }
    await h.loop.runTurn(h.threadId, h.turnId)
    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items.some((item) => item.kind === 'compaction')).toBe(true)
  })

  it('can use a model summary for history compaction while reusing the main prefix', async () => {
    const requests: ModelRequest[] = []
    const h = makeHarness(
      {
        provider: 'fold-summary',
        model: 'fold-summary',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          const isSummaryRequest = request.tools.length === 0 &&
            request.contextInstructions?.some((text) => text.includes('history fold'))
          if (isSummaryRequest) {
            yield {
              kind: 'usage',
              usage: {
                promptTokens: 22,
                completionTokens: 7,
                totalTokens: 29,
                cachedTokens: 0,
                cacheHitTokens: 0,
                cacheMissTokens: 22,
                cacheHitRate: 0,
                turns: 1
              }
            }
            yield {
              kind: 'assistant_text_delta',
              text: 'Model summary: preserve alpha.txt and continue with beta.'
            }
            yield { kind: 'completed', stopReason: 'stop' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        compactor: new ContextCompactor({ softThreshold: 8, hardThreshold: 16 }),
        contextCompaction: {
          summaryMode: 'model',
          summaryTimeoutMs: 5_000,
          summaryMaxTokens: 333,
          summaryInputMaxBytes: 4_096
        }
      }
    )
    await bootstrapThread(h)
    for (let i = 0; i < 10; i += 1) {
      await h.sessionStore.appendItem(
        h.threadId,
        makeUserItem({
          id: `model_summary_hist_${i}`,
          turnId: h.turnId,
          threadId: h.threadId,
          text: `alpha.txt observation ${i}; next step beta ${'x'.repeat(24)}`
        })
      )
    }

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const [summaryRequest, mainRequest] = requests
    if (!summaryRequest || !mainRequest) throw new Error('expected summary and main model requests')
    const summaryPromptItem = summaryRequest.history[0]
    const persisted = await h.sessionStore.loadItems(h.threadId)
    const persistedSummary = persisted.find((item) => item.kind === 'compaction')
    const mainSummary = mainRequest.history.find((item) => item.kind === 'compaction')

    expect(status).toBe('completed')
    expect(requests).toHaveLength(2)
    expect(summaryRequest.systemPrompt).toBe('be brief')
    expect(summaryRequest.prefix).toBe(h.prefix.fewShots)
    expect(summaryRequest.tools).toEqual([])
    expect(summaryRequest.maxTokens).toBe(333)
    expect(summaryRequest.temperature).toBe(0)
    expect(summaryRequest.reasoningEffort).toBe('off')
    expect(summaryRequest.contextInstructions?.join('\n')).toContain('history fold')
    expect(summaryPromptItem?.kind).toBe('user_message')
    expect(summaryPromptItem?.kind === 'user_message' ? summaryPromptItem.text : '')
      .toContain('需要折叠的历史摘录')
    expect(mainSummary?.kind === 'compaction' ? mainSummary.summary : '')
      .toContain('Model summary: preserve alpha.txt')
    expect(persistedSummary?.kind === 'compaction' ? persistedSummary.summary : '')
      .toContain('Model summary: preserve alpha.txt')
  })

  it('records a visible fallback event when configured model compaction summaries fail', async () => {
    const requests: ModelRequest[] = []
    const h = makeHarness(
      {
        provider: 'fold-summary-fails',
        model: 'fold-summary-fails',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          requests.push(request)
          const isSummaryRequest = request.tools.length === 0 &&
            request.contextInstructions?.some((text) => text.includes('history fold'))
          if (isSummaryRequest) {
            yield { kind: 'error', message: 'summary model unavailable', code: 'summary_down' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        compactor: new ContextCompactor({ softThreshold: 8, hardThreshold: 16 }),
        contextCompaction: {
          summaryMode: 'model',
          summaryTimeoutMs: 5_000
        }
      }
    )
    await bootstrapThread(h)
    for (let i = 0; i < 10; i += 1) {
      await h.sessionStore.appendItem(
        h.threadId,
        makeUserItem({
          id: `fallback_hist_${i}`,
          turnId: h.turnId,
          threadId: h.threadId,
          text: `fallback observation ${i} ${'x'.repeat(24)}`
        })
      )
    }

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const events = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const fallback = events.find(
      (event) => event.kind === 'error' && event.code === 'compaction_summary_fallback'
    )
    const persisted = await h.sessionStore.loadItems(h.threadId)

    expect(status).toBe('completed')
    expect(requests).toHaveLength(2)
    expect(fallback?.kind === 'error' ? fallback.message : '').toContain('summary model unavailable')
    expect(persisted.some((item) =>
      item.kind === 'compaction' &&
      item.summary.includes('Conversation and work summary:') &&
      item.summary.includes('<legalwork:tool_digest sha256=')
    )).toBe(true)
  })

  it('compacts on the next step when provider usage reports high prompt tokens', async () => {
    const seenHistory: TurnItem[][] = []
    const echoTool = LocalToolHost.defineTool({
      name: 'echo',
      description: 'Echo text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text']
      },
      policy: 'auto',
      execute: async () => ({ output: 'tool result from high usage turn' })
    })
    let calls = 0
    const h = makeHarness(
      {
        provider: 'usage-pressure',
        model: 'usage-pressure',
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
          seenHistory.push(request.history)
          calls += 1
          if (calls === 1) {
            yield {
              kind: 'usage',
              usage: {
                promptTokens: 12,
                completionTokens: 1,
                totalTokens: 13,
                cachedTokens: 0,
                cacheHitTokens: 0,
                cacheMissTokens: 12,
                cacheHitRate: 0,
                turns: 1
              }
            }
            yield {
              kind: 'tool_call_complete',
              callId: 'call_echo',
              toolName: 'echo',
              arguments: { text: 'hi' }
            }
            yield { kind: 'completed', stopReason: 'tool_calls' }
            return
          }
          yield { kind: 'completed', stopReason: 'stop' }
        }
      },
      {
        tools: [echoTool],
        compactor: new ContextCompactor({ softThreshold: 10, hardThreshold: 20 })
      }
    )
    await bootstrapThread(h)

    const status = await h.loop.runTurn(h.threadId, h.turnId)
    const secondHistory = seenHistory[1] ?? []
    const persisted = await h.sessionStore.loadItems(h.threadId)

    expect(status).toBe('completed')
    expect(seenHistory[0]?.some((item) => item.kind === 'compaction')).toBe(false)
    expect(secondHistory[0]?.kind).toBe('compaction')
    expect(secondHistory.some((item) => item.kind === 'tool_result')).toBe(true)
    expect(
      secondHistory.some((item) =>
        item.kind === 'compaction' && item.summary.includes('compaction threshold')
      )
    ).toBe(true)
    expect(persisted.some((item) => item.kind === 'compaction')).toBe(true)
  })

  it('warns once near the thread cost budget and blocks when exhausted', async () => {
    let modelCalls = 0
    const h = makeHarness({
      provider: 'budget',
      model: 'budget',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        modelCalls += 1
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await bootstrapThread(h)
    const thread = await h.threadStore.get(h.threadId)
    await h.threadStore.upsert({ ...thread!, costBudgetUsd: 10 })
    h.usage.record(h.threadId, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheHitRate: null,
      turns: 0,
      costUsd: 8
    })

    await h.loop.runTurn(h.threadId, h.turnId)
    const warnedThread = await h.threadStore.get(h.threadId)
    expect(modelCalls).toBe(1)
    expect(warnedThread?.costBudgetWarningSent).toBe(true)
    expect((await h.sessionStore.loadItems(h.threadId)).some((item) =>
      item.kind === 'error' && item.code === 'budget_warning'
    )).toBe(true)

    const second = await h.turns.startTurn({ threadId: h.threadId, request: { prompt: 'again' } })
    h.turnId = second.turnId
    h.usage.record(h.threadId, {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheHitRate: null,
      turns: 0,
      costUsd: 2
    })
    await h.loop.runTurn(h.threadId, h.turnId)
    expect(modelCalls).toBe(1)
    expect((await h.sessionStore.loadItems(h.threadId)).some((item) =>
      item.kind === 'error' && item.code === 'budget_limited'
    )).toBe(true)
  })

  it('does not auto-compact DeepSeek v4 turns at the legacy threshold', async () => {
    const h = makeHarness(makeSilentModel(), {
      compactor: new ContextCompactor()
    })
    await bootstrapThread(h, { request: { prompt: 'hello', model: 'deepseek-v4-flash' } })
    await h.sessionStore.appendItem(
      h.threadId,
      makeUserItem({
        id: 'legacy_threshold_sized_history',
        turnId: h.turnId,
        threadId: h.threadId,
        text: 'x'.repeat(80_000)
      })
    )

    await h.loop.runTurn(h.threadId, h.turnId)

    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items.some((item) => item.kind === 'compaction')).toBe(false)
  })

  it('routes turn model auto before sending the real model request', async () => {
    const seenModels: string[] = []
    const h = makeHarness({
      provider: 'router-recorder',
      model: 'fallback',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        seenModels.push(request.model)
        if (request.turnId.endsWith('_auto_router')) {
          expect(request.stream).toBe(false)
          expect(request.maxTokens).toBe(96)
          yield { kind: 'assistant_text_delta', text: '{"model":"deepseek-v4-pro","thinking":"max"}' }
          yield { kind: 'completed', stopReason: 'stop' }
          return
        }
        expect(request.reasoningEffort).toBe('max')
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await h.threadStore.upsert(
      createThreadRecord({
        id: h.threadId,
        title: 'demo',
        workspace: '/tmp',
        model: 'deepseek-v4-flash'
      })
    )
    const { turnId } = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'hello', model: 'auto' }
    })

    await h.loop.runTurn(h.threadId, turnId)

    expect(seenModels).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })

  it('keeps explicit turn reasoning effort when auto routing chooses the model', async () => {
    const seenModels: string[] = []
    const h = makeHarness({
      provider: 'router-reasoning-override',
      model: 'fallback',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        seenModels.push(request.model)
        if (request.turnId.endsWith('_auto_router')) {
          yield { kind: 'assistant_text_delta', text: '{"model":"deepseek-v4-pro","thinking":"max"}' }
          yield { kind: 'completed', stopReason: 'stop' }
          return
        }
        expect(request.reasoningEffort).toBe('low')
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await h.threadStore.upsert(
      createThreadRecord({
        id: h.threadId,
        title: 'demo',
        workspace: '/tmp',
        model: 'auto'
      })
    )
    const { turnId } = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'hello', model: 'auto', reasoningEffort: 'low' }
    })

    await h.loop.runTurn(h.threadId, turnId)

    expect(seenModels).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })

  it('falls back to a concrete heuristic model when auto router fails', async () => {
    let realRequestModel = ''
    const h = makeHarness({
      provider: 'router-failure',
      model: 'auto',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        if (request.turnId.endsWith('_auto_router')) {
          yield { kind: 'error', message: 'router unavailable' }
          return
        }
        realRequestModel = request.model
        expect(request.reasoningEffort).toBe('high')
        yield { kind: 'completed', stopReason: 'stop' }
      }
    })
    await h.threadStore.upsert(
      createThreadRecord({
        id: h.threadId,
        title: 'demo',
        workspace: '/tmp',
        model: 'auto'
      })
    )
    const { turnId } = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'hello' }
    })

    await h.loop.runTurn(h.threadId, turnId)

    expect(realRequestModel).toBe('deepseek-v4-flash')
  })

  it('uses the latest compaction item as the effective history boundary', async () => {
    const seenHistory: ModelRequest['history'][] = []
    const h = makeHarness({
      provider: 'recorder',
      model: 'recorder',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        seenHistory.push(request.history)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, {
      compactor: new ContextCompactor({ softThreshold: 100_000, hardThreshold: 120_000 })
    })
    await bootstrapThread(h)
    await h.turns.finishTurn({ threadId: h.threadId, turnId: h.turnId, status: 'completed' })
    for (let i = 0; i < 8; i += 1) {
      await h.sessionStore.appendItem(
        h.threadId,
        makeUserItem({
          id: `manual_hist_${i}`,
          turnId: h.turnId,
          threadId: h.threadId,
          text: i === 0 ? 'original requirement alpha' : `old detail ${i}`
        })
      )
    }

    const compacted = await h.turns.compact({
      threadId: h.threadId,
      request: { reason: 'manual test' }
    })
    expect(compacted.summary).toContain('original requirement alpha')

    const next = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: 'continue after compact' }
    })
    h.turnId = next.turnId
    await h.loop.runTurn(h.threadId, h.turnId)

    const history = seenHistory[0] ?? []
    expect(history[0]?.kind).toBe('compaction')
    expect(
      history.some((item) => item.kind === 'user_message' && item.text === 'original requirement alpha')
    ).toBe(false)
    expect(
      history.some((item) => item.kind === 'user_message' && item.text === 'continue after compact')
    ).toBe(true)
    expect(
      history.some((item) => item.kind === 'compaction' && item.summary.includes('original requirement alpha'))
    ).toBe(true)
  })

  it('records usage and emits a usage event', async () => {
    const h = makeHarness(
      makeFakeModel([
        {
          kind: 'usage',
          usage: {
            promptTokens: 12,
            completionTokens: 4,
            totalTokens: 16,
            cachedTokens: 6,
            cacheHitTokens: 6,
            cacheMissTokens: 6,
            cacheHitRate: 0.5,
            turns: 1
          }
        },
        { kind: 'completed', stopReason: 'stop' }
      ])
    )
    await bootstrapThread(h)
    const seen: number[] = []
    h.bus.subscribe(h.threadId, (event) => {
      if (event.kind === 'usage') seen.push(event.seq)
    })
    await h.loop.runTurn(h.threadId, h.turnId)
    expect(seen.length).toBeGreaterThan(0)
    const replay = await h.sessionStore.loadEventsSince(h.threadId, 0)
    expect(replay.some((event) => event.kind === 'usage')).toBe(true)
  })

  it('persists assistant text deltas for SSE replay before the final item', async () => {
    const h = makeHarness(
      makeFakeModel([
        { kind: 'assistant_text_delta', text: 'he' },
        { kind: 'assistant_text_delta', text: 'llo' },
        { kind: 'completed', stopReason: 'stop' }
      ])
    )
    await bootstrapThread(h)
    await h.loop.runTurn(h.threadId, h.turnId)
    const replay = await h.sessionStore.loadEventsSince(h.threadId, 0)
    const deltas = replay.filter((event) => event.kind === 'assistant_text_delta')
    expect(deltas).toHaveLength(2)
    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items.some((item) => item.kind === 'assistant_text' && item.text === 'hello')).toBe(true)
  })

  it('persists completed reasoning before completed assistant text', async () => {
    const h = makeHarness(
      makeFakeModel([
        { kind: 'assistant_reasoning_delta', text: 'thinking' },
        { kind: 'assistant_text_delta', text: 'answer' },
        { kind: 'completed', stopReason: 'stop' }
      ])
    )
    await bootstrapThread(h)
    await h.loop.runTurn(h.threadId, h.turnId)

    const itemKinds = (await h.sessionStore.loadItems(h.threadId))
      .filter((item) => item.kind === 'assistant_reasoning' || item.kind === 'assistant_text')
      .map((item) => item.kind)

    expect(itemKinds).toEqual(['assistant_reasoning', 'assistant_text'])
  })
})

describe('FileSessionStore', () => {
  let dataDir = ''
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'legalwork-test-'))
    await mkdir(dataDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('persists events and items as JSONL with atomic index writes', async () => {
    const threadStore = new FileThreadStore({ dataDir })
    const sessionStore = new FileSessionStore({ dataDir })
    await threadStore.upsert(
      createThreadRecord({ id: 'thr_x', title: 'demo', workspace: '/tmp', model: 'm' })
    )
    await sessionStore.appendEvent('thr_x', {
      kind: 'heartbeat',
      seq: 1,
      timestamp: new Date().toISOString(),
      threadId: 'thr_x'
    })
    const events = await sessionStore.loadEventsSince('thr_x', 0)
    expect(events).toHaveLength(1)
    const content = await readFile(join(dataDir, 'threads', 'thr_x', 'events.jsonl'), 'utf-8')
    expect(content.endsWith('\n')).toBe(true)
    const index = JSON.parse(
      await readFile(join(dataDir, 'threads', 'index.json'), 'utf-8')
    ) as { order: string[] }
    expect(index.order).toContain('thr_x')
  })

  it('handles concurrent file thread index writes in the same millisecond', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      const threadStore = new FileThreadStore({
        dataDir,
        now: () => new Date('2026-06-03T00:00:00.000Z')
      })
      const threads = Array.from({ length: 20 }, (_, index) =>
        createThreadRecord({
          id: `thr_concurrent_${index}`,
          title: `demo ${index}`,
          workspace: '/tmp',
          model: 'm'
        })
      )

      await expect(Promise.all(threads.map((thread) => threadStore.upsert(thread))))
        .resolves.toHaveLength(20)
      const index = JSON.parse(
        await readFile(join(dataDir, 'threads', 'index.json'), 'utf-8')
      ) as { order: string[] }

      expect(index.order).toEqual(expect.arrayContaining(threads.map((thread) => thread.id)))
    } finally {
      spy.mockRestore()
    }
  })

  it('continues event sequence numbers after a file-backed restart', async () => {
    const sessionStore = new FileSessionStore({ dataDir })
    await sessionStore.appendEvent('thr_seq', {
      kind: 'heartbeat',
      seq: 7,
      timestamp: new Date().toISOString(),
      threadId: 'thr_seq'
    })
    const bus = new InMemoryEventBus()
    const recorder = new RuntimeEventRecorder({
      eventBus: bus,
      sessionStore,
      allocateSeq: (threadId) => bus.allocateSeq(threadId),
      nowIso: () => new Date().toISOString()
    })
    const event = await recorder.record({ kind: 'heartbeat', threadId: 'thr_seq' })
    expect(event.seq).toBe(8)
  })

  it('survives a malformed JSONL line', async () => {
    const sessionStore = new FileSessionStore({ dataDir })
    await mkdir(join(dataDir, 'threads', 'thr_y'), { recursive: true })
    await appendFile(
      join(dataDir, 'threads', 'thr_y', 'events.jsonl'),
      '{"kind":"heartbeat","seq":1,"timestamp":"t","threadId":"thr_y"}\n',
      'utf-8'
    )
    const events = await sessionStore.loadEventsSince('thr_y', 0)
    expect(events).toHaveLength(1)
  })

  it('compacts usage events by retention window while preserving a carryover baseline', async () => {
    const sessionStore = new FileSessionStore({
      dataDir,
      usageEventCompaction: {
        maxBytes: 1,
        retentionDays: 365,
        nowIso: () => '2026-06-03T00:00:00.000Z'
      }
    })
    const usage = (tokens: number) => ({
      promptTokens: tokens,
      completionTokens: 0,
      totalTokens: tokens,
      cacheHitRate: null,
      turns: tokens
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'heartbeat',
      seq: 1,
      timestamp: '2024-01-01T00:00:00.000Z',
      threadId: 'thr_usage_compact'
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 2,
      timestamp: '2024-01-01T00:00:00.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-chat',
      usage: usage(2)
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 3,
      timestamp: '2025-06-02T23:59:59.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-chat',
      usage: usage(3)
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 4,
      timestamp: '2025-06-04T00:00:00.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-chat',
      usage: usage(4)
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 5,
      timestamp: '2025-06-04T01:00:00.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-chat',
      usage: usage(5)
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 6,
      timestamp: '2025-06-04T02:00:00.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-reasoner',
      usage: usage(6)
    })
    await sessionStore.appendEvent('thr_usage_compact', {
      kind: 'usage',
      seq: 7,
      timestamp: '2026-06-02T00:00:00.000Z',
      threadId: 'thr_usage_compact',
      model: 'deepseek-reasoner',
      usage: usage(7)
    })

    const events = await sessionStore.loadEventsSince('thr_usage_compact', 0)
    expect(events.map((event) => event.seq)).toEqual([1, 3, 5, 6, 7])
    expect(await sessionStore.highestSeq('thr_usage_compact')).toBe(7)
  })
})
