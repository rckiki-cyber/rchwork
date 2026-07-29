import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import {
  scheduleStartupRuntimeProbe,
  stopTurnCompletionPoll,
  syncTurnCompletionPoll
} from './chat-store-schedulers'

afterEach(() => {
  stopTurnCompletionPoll()
  vi.useRealTimers()
})

describe('syncTurnCompletionPoll', () => {
  it('does not overlap polling ticks while a thread detail request is pending', async () => {
    vi.useFakeTimers()
    let resolveFirst!: (value: { blocks: []; threadStatus: string }) => void
    const first = new Promise<{ blocks: []; threadStatus: string }>((resolve) => {
      resolveFirst = resolve
    })
    const loadThreadState = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ blocks: [], threadStatus: 'running' })
    const state = {
      runtimeConnection: 'ready',
      watchTurnCompletion: { thr_1: true }
    } as unknown as ChatState
    const get: ChatStoreGet = () => state
    const set: ChatStoreSet = (partial) => {
      const update = typeof partial === 'function' ? partial(state) : partial
      Object.assign(state, update)
    }

    syncTurnCompletionPoll(set, get, {
      loadThreadState,
      threadLooksRunning: () => true,
      onCompletedThreads: vi.fn()
    })
    await vi.advanceTimersByTimeAsync(7_500)

    expect(loadThreadState).toHaveBeenCalledTimes(1)
    resolveFirst({ blocks: [], threadStatus: 'running' })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(2_500)

    expect(loadThreadState).toHaveBeenCalledTimes(2)
  })
})

describe('scheduleStartupRuntimeProbe', () => {
  it('uses the requested recovery delay and runs one probe', async () => {
    vi.useFakeTimers()
    const probeRuntime = vi.fn(async () => undefined)
    const state = { probeRuntime } as unknown as ChatState

    scheduleStartupRuntimeProbe(() => state, 2_000)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(probeRuntime).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(probeRuntime).toHaveBeenCalledOnce()
    expect(probeRuntime).toHaveBeenCalledWith('background')
  })
})
