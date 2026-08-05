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
