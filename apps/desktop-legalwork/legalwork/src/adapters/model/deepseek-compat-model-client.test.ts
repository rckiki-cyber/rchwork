import { describe, expect, it, vi } from 'vitest'
import { DeepseekCompatModelClient } from './deepseek-compat-model-client.js'
import { modelCapabilitiesForModel } from '../../loop/model-context-profile.js'
import type { ModelRequest } from '../../ports/model-client.js'

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    model: 'kimi-for-coding',
    systemPrompt: 'You are helpful.',
    prefix: [],
    history: [
      {
        kind: 'user_message',
        id: 'item-1',
        turnId: 'turn-1',
        threadId: 'thread-1',
        role: 'user',
        status: 'completed',
        createdAt: '2026-01-01T00:00:00.000Z',
        text: 'Hello'
      }
    ],
    tools: [],
    stream: false,
    abortSignal: new AbortController().signal,
    ...overrides
  }
}

function okChatResponse(): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-1',
    model: 'kimi-for-coding',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Hi' }
      }
    ],
    usage: {}
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

describe('DeepseekCompatModelClient Kimi Code compatibility', () => {
  it('streams reasoning_content from OpenAI-compatible providers', async () => {
    const encoder = new TextEncoder()
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"choices":[{"delta":{"reasoning_content":"Check the evidence."},"finish_reason":null}]}',
          '',
          'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}],"usage":{}}',
          '',
          'data: [DONE]',
          ''
        ].join('\n')))
        controller.close()
      }
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }))
    const client = new DeepseekCompatModelClient({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-qwen',
      model: 'qwen-plus',
      endpointFormat: 'chat_completions',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const chunks = []
    for await (const chunk of client.stream(request({
      model: 'qwen-plus',
      stream: true
    }))) {
      chunks.push(chunk)
    }

    expect(chunks).toContainEqual({
      kind: 'assistant_reasoning_delta',
      text: 'Check the evidence.'
    })
    expect(chunks).toContainEqual({ kind: 'assistant_text_delta', text: 'Answer' })
  })

  it('enables DashScope thinking for reasoning profiles with a generic protocol', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okChatResponse())
    const client = new DeepseekCompatModelClient({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'sk-qwen',
      model: 'qwen3.7-plus',
      endpointFormat: 'chat_completions',
      nonStreaming: true,
      modelCapabilities: (model) => ({
        id: model,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text'],
        reasoning: {
          supportedEfforts: ['auto', 'off'],
          defaultEffort: 'auto',
          requestProtocol: 'none'
        }
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    for await (const _ of client.stream(request({
      model: 'qwen3.7-plus',
      reasoningEffort: 'auto'
    }))) {
      // consume
    }

    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>
    expect(body.enable_thinking).toBe(true)
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('translates GLM reasoning controls on the official BigModel endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okChatResponse())
    const client = new DeepseekCompatModelClient({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-glm',
      model: 'glm-5.2',
      endpointFormat: 'chat_completions',
      nonStreaming: true,
      modelCapabilities: (model) => ({
        id: model,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text'],
        reasoning: {
          supportedEfforts: ['off', 'high', 'max'],
          defaultEffort: 'max',
          requestProtocol: 'none'
        }
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    for await (const _ of client.stream(request({
      model: 'glm-5.2',
      reasoningEffort: 'max'
    }))) {
      // consume
    }

    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('translates Doubao auto thinking on the official Ark endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okChatResponse())
    const client = new DeepseekCompatModelClient({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: 'sk-ark',
      model: 'doubao-seed-1-6-250615',
      endpointFormat: 'chat_completions',
      nonStreaming: true,
      modelCapabilities: (model) => ({
        id: model,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text'],
        reasoning: {
          supportedEfforts: ['auto', 'off'],
          defaultEffort: 'auto',
          requestProtocol: 'none'
        }
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    for await (const _ of client.stream(request({
      model: 'doubao-seed-1-6-250615',
      reasoningEffort: 'auto'
    }))) {
      // consume
    }

    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'auto' })
  })

  it('requests structured MiniMax reasoning instead of embedded think tags', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okChatResponse())
    const client = new DeepseekCompatModelClient({
      baseUrl: 'https://api.minimaxi.com/v1',
      apiKey: 'sk-minimax',
      model: 'MiniMax-M3',
      endpointFormat: 'chat_completions',
      nonStreaming: true,
      modelCapabilities: (model) => ({
        id: model,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text'],
        reasoning: {
          supportedEfforts: ['auto', 'off'],
          defaultEffort: 'auto',
          requestProtocol: 'none'
        }
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    for await (const _ of client.stream(request({
      model: 'MiniMax-M3',
      reasoningEffort: 'auto'
    }))) {
      // consume
    }

    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>
    expect(body.reasoning_split).toBe(true)
    expect(body.thinking).toEqual({ type: 'adaptive' })
  })

  it('requests detailed reasoning summaries from OpenAI Responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-1',
      status: 'completed',
      output: [{
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Checked the evidence.' }]
      }, {
        type: 'message',
        content: [{ type: 'output_text', text: 'Answer' }]
      }],
      usage: {}
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    const client = new DeepseekCompatModelClient({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      model: 'o3-mini',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const chunks = []
    for await (const chunk of client.stream(request({
      model: 'o3-mini',
      reasoningEffort: 'high'
    }))) {
      chunks.push(chunk)
    }

    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'detailed' })
    expect(chunks).toContainEqual({
      kind: 'assistant_reasoning_delta',
      text: 'Checked the evidence.'
    })
  })

  it('does not send reasoning controls to non-reasoning OpenAI models', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'resp-1',
      status: 'completed',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'Answer' }]
      }],
      usage: {}
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    const client = new DeepseekCompatModelClient({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      model: 'gpt-4o',
      endpointFormat: 'responses',
      nonStreaming: true,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    for await (const _ of client.stream(request({
      model: 'gpt-4o',
      reasoningEffort: 'high'
    }))) {
      // consume
    }

    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty('reasoning')
  })

  it('uses the Kimi Code OpenAI-compatible URL and reasoning protocol', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okChatResponse())
    const client = new DeepseekCompatModelClient({
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-kimi',
      model: 'kimi-for-coding',
      endpointFormat: 'chat_completions',
      nonStreaming: true,
      modelCapabilities: modelCapabilitiesForModel,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    for await (const _ of client.stream(request({ reasoningEffort: 'medium' }))) {
      // consume
    }

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.kimi.com/coding/v1/chat/completions',
      expect.objectContaining({
        method: 'POST'
      })
    )
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>
    expect(body.model).toBe('kimi-for-coding')
    expect(body.reasoning_effort).toBe('medium')
    expect(body).not.toHaveProperty('thinking')
  })

  it('classifies HTTP 402 as insufficient_balance', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('Insufficient Balance', { status: 402 })
    )
    const client = new DeepseekCompatModelClient({
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-kimi',
      model: 'kimi-for-coding',
      endpointFormat: 'chat_completions',
      nonStreaming: true,
      modelCapabilities: modelCapabilitiesForModel,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const chunks = []
    for await (const chunk of client.stream(request())) {
      chunks.push(chunk)
    }

    const error = chunks.find((chunk) => chunk.kind === 'error')
    expect(error?.kind).toBe('error')
    if (error?.kind === 'error') {
      expect(error.code).toBe('insufficient_balance')
      expect(error.message).toContain('余额不足')
    }
  })

  it('classifies HTTP 429 as rate_limited', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('Too Many Requests', { status: 429 })
    )
    const client = new DeepseekCompatModelClient({
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-kimi',
      model: 'kimi-for-coding',
      endpointFormat: 'chat_completions',
      nonStreaming: true,
      modelCapabilities: modelCapabilitiesForModel,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    const chunks = []
    for await (const chunk of client.stream(request())) {
      chunks.push(chunk)
    }

    const error = chunks.find((chunk) => chunk.kind === 'error')
    expect(error?.kind).toBe('error')
    if (error?.kind === 'error') {
      expect(error.code).toBe('rate_limited')
    }
  })
})
