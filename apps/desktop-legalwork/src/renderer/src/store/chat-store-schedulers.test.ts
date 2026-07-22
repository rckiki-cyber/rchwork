import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import { stopTurnCompletionPoll, syncTurnCompletionPoll } from './chat-store-schedulers'

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
