import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'

const registryMock = vi.hoisted(() => ({
  getProvider: vi.fn()
}))

vi.mock('../agent/registry', () => ({
  getProvider: registryMock.getProvider
}))

import { createThreadActions } from './chat-store-thread-actions'

describe('createThreadActions recovery', () => {
  beforeEach(() => {
    registryMock.getProvider.mockReset()
  })

  it('shares one active-turn recovery request across concurrent callers', async () => {
    let resolveDetail!: (value: {
      blocks: []
      latestSeq: number
      threadStatus: string
    }) => void
    const detail = new Promise<{
      blocks: []
      latestSeq: number
      threadStatus: string
    }>((resolve) => {
      resolveDetail = resolve
    })
    const provider = {
      getThreadDetail: vi.fn(() => detail),
      subscribeThreadEvents: vi.fn(() => new Promise<void>(() => undefined))
    }
    registryMock.getProvider.mockReturnValue(provider)

    const drainQueuedMessages = vi.fn(async () => undefined)
    const state = {
      activeThreadId: 'thr_1',
      activeThreadGoal: null,
      activeThreadTodos: null,
      blocks: [],
      busy: true,
      currentTurnId: 'turn_1',
      currentTurnUserId: 'user_1',
      drainQueuedMessages,
      error: null,
      lastSeq: 0,
      liveAssistant: '',
      liveReasoning: '',
      queuedMessages: [{ id: 'q-1', text: 'next' }],
      turnDurationByUserId: {}
    } as unknown as ChatState
    const get: ChatStoreGet = () => state
    const set: ChatStoreSet = (partial) => {
      const update = typeof partial === 'function' ? partial(state) : partial
      Object.assign(state, update)
    }
    const actions = createThreadActions({
      set,
      get,
      sseAbortRef: { current: null }
    })
    state.recoverActiveTurn = actions.recoverActiveTurn

    const first = actions.recoverActiveTurn()
    const second = actions.recoverActiveTurn()

    expect(first).toBe(second)
    expect(provider.getThreadDetail).toHaveBeenCalledTimes(1)
    resolveDetail({ blocks: [], latestSeq: 7, threadStatus: 'idle' })
    await Promise.all([first, second])

    expect(state.busy).toBe(false)
    expect(state.error).toBeNull()
    expect(drainQueuedMessages).toHaveBeenCalledTimes(1)
  })
})
