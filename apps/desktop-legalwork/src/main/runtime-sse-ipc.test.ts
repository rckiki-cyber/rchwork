import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultLegalworkRuntimeSettings,
  defaultLearningIterationSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsV1
} from '../shared/app-settings'
import {
  registerRuntimeSseIpc,
  stopAllRuntimeSse,
  stopRuntimeSseForWebContents
} from './runtime-sse-ipc'

type Handler = (event: { sender: WebContentsMock }, payload?: unknown) => Promise<unknown>

class WebContentsMock extends EventEmitter {
  readonly id: number
  readonly send = vi.fn()
  private destroyed = false

  constructor(id: number) {
    super()
    this.id = id
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

const handlers = new Map<string, Handler>()

function settings(): AppSettingsV1 {
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: defaultModelProviderSettings(),
    agents: {
      legalwork: defaultLegalworkRuntimeSettings()
    },
    workspaceRoot: '/tmp/workspace',
    log: { enabled: false, retentionDays: 7 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: defaultScheduleSettings(),
    learningIteration: defaultLearningIterationSettings(),
    guiUpdate: { channel: 'stable' }
  }
}

function register(options: {
  ensureRuntime?: () => Promise<void>
  reconnectBaseMs?: number
  reconnectMaxMs?: number
} = {}): void {
  registerRuntimeSseIpc({
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        handlers.set(channel, handler)
      }
    } as never,
    store: { load: vi.fn(async () => settings()) } as never,
    ensureRuntime: options.ensureRuntime ?? vi.fn(async () => undefined),
    logError: vi.fn(),
    ...(options.reconnectBaseMs !== undefined ? { reconnectBaseMs: options.reconnectBaseMs } : {}),
    ...(options.reconnectMaxMs !== undefined ? { reconnectMaxMs: options.reconnectMaxMs } : {})
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(predicate()).toBe(true)
}

describe('runtime SSE IPC lifecycle', () => {
  beforeEach(() => {
    handlers.clear()
    vi.restoreAllMocks()
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }))
  })

  afterEach(() => {
    stopAllRuntimeSse()
    vi.unstubAllGlobals()
  })

  it('coalesces adjacent text deltas before crossing the IPC boundary', async () => {
    let closeStream: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          closeStream = () => controller.close()
          const encoder = new TextEncoder()
          for (let seq = 1; seq <= 200; seq += 1) {
            controller.enqueue(encoder.encode(
              `id: ${seq}\nevent: assistant_text_delta\ndata: ${JSON.stringify({
                kind: 'assistant_text_delta',
                seq,
                item: { id: 'assistant-1', text: '字' }
              })}\n\n`
            ))
          }
          init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
        }
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }))
    register()
    const sender = new WebContentsMock(3)
    await handlers.get('runtime:sse:start')?.({ sender }, {
      threadId: 'thr_delta',
      sinceSeq: 0,
      streamId: 'stream_delta'
    })

    await new Promise((resolve) => setTimeout(resolve, 60))

    const eventCalls = sender.send.mock.calls.filter(([channel]) => channel === 'runtime:sse-event')
    expect(eventCalls).toHaveLength(1)
    const payload = eventCalls[0]?.[1] as { data: { seq: number; item: { text: string } } }
    expect(payload.data.seq).toBe(200)
    expect(payload.data.item.text).toBe('字'.repeat(200))
    ;(closeStream as (() => void) | null)?.()
    stopAllRuntimeSse()
  })

  it('paces a large non-delta backlog across multiple renderer turns', async () => {
    let closeStream: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          closeStream = () => controller.close()
          const encoder = new TextEncoder()
          for (let seq = 1; seq <= 130; seq += 1) {
            controller.enqueue(encoder.encode(
              `id: ${seq}\nevent: heartbeat\ndata: ${JSON.stringify({ kind: 'heartbeat', seq })}\n\n`
            ))
          }
          init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
        }
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }))
    register()
    const sender = new WebContentsMock(4)
    await handlers.get('runtime:sse:start')?.({ sender }, {
      threadId: 'thr_backlog',
      sinceSeq: 0,
      streamId: 'stream_backlog'
    })

    await new Promise((resolve) => setTimeout(resolve, 22))
    let eventCalls = sender.send.mock.calls.filter(([channel]) => channel === 'runtime:sse-event')
    expect(eventCalls).toHaveLength(1)
    expect((eventCalls[0]?.[1] as { data: unknown[] }).data).toHaveLength(60)

    await new Promise((resolve) => setTimeout(resolve, 45))
    eventCalls = sender.send.mock.calls.filter(([channel]) => channel === 'runtime:sse-event')
    expect(eventCalls).toHaveLength(3)
    expect((eventCalls[2]?.[1] as { data: unknown[] }).data).toHaveLength(10)
    ;(closeStream as (() => void) | null)?.()
    stopAllRuntimeSse()
  })

  it('notifies the renderer when the host stops all SSE streams', async () => {
    register()
    const sender = new WebContentsMock(1)
    await handlers.get('runtime:sse:start')?.({
      sender
    }, {
      threadId: 'thr_1',
      sinceSeq: 0,
      streamId: 'stream_1'
    })

    stopAllRuntimeSse()

    await waitFor(() => sender.send.mock.calls.some(([channel]) => channel === 'runtime:sse-end'))
    expect(sender.send).toHaveBeenCalledWith('runtime:sse-end', { streamId: 'stream_1' })
  })

  it('stops only streams owned by the requested web contents', async () => {
    register()
    const first = new WebContentsMock(1)
    const second = new WebContentsMock(2)
    await handlers.get('runtime:sse:start')?.({ sender: first }, {
      threadId: 'thr_1',
      sinceSeq: 0,
      streamId: 'stream_1'
    })
    await handlers.get('runtime:sse:start')?.({ sender: second }, {
      threadId: 'thr_2',
      sinceSeq: 0,
      streamId: 'stream_2'
    })

    stopRuntimeSseForWebContents(first.id)

    await waitFor(() => first.send.mock.calls.some(([channel]) => channel === 'runtime:sse-end'))
    expect(first.send).toHaveBeenCalledWith('runtime:sse-end', { streamId: 'stream_1' })
    expect(second.send).not.toHaveBeenCalledWith('runtime:sse-end', { streamId: 'stream_2' })
    stopAllRuntimeSse()
  })

  it('re-ensures the runtime before reconnecting an interrupted stream', async () => {
    const encoder = new TextEncoder()
    let attempts = 0
    let closeStream: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn(() => {
      attempts += 1
      if (attempts === 1) return Promise.reject(new Error('fetch failed'))
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          closeStream = () => controller.close()
          controller.enqueue(encoder.encode(
            'id: 1\nevent: heartbeat\ndata: {"kind":"heartbeat","seq":1}\n\n'
          ))
        }
      }), { status: 200 }))
    }))
    const ensureRuntime = vi.fn(async () => undefined)
    register({ ensureRuntime, reconnectBaseMs: 1, reconnectMaxMs: 1 })
    const sender = new WebContentsMock(5)

    await handlers.get('runtime:sse:start')?.({ sender }, {
      threadId: 'thr_recover',
      sinceSeq: 0,
      streamId: 'stream_recover'
    })

    await waitFor(() => sender.send.mock.calls.some(([channel]) => channel === 'runtime:sse-event'))
    expect(ensureRuntime).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenCalledWith('runtime:sse-event', {
      streamId: 'stream_recover',
      data: { kind: 'heartbeat', seq: 1 }
    })
    ;(closeStream as (() => void) | null)?.()
    stopAllRuntimeSse()
  })
})
