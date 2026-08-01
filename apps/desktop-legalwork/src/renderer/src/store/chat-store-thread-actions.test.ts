import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'

const registryMock = vi.hoisted(() => ({
  getProvider: vi.fn()
}))

const runtimeClientMock = vi.hoisted(() => ({
  getSettings: vi.fn()
}))

vi.mock('../agent/registry', () => ({
  getProvider: registryMock.getProvider
}))

vi.mock('../agent/runtime-client', () => ({
  rendererRuntimeClient: runtimeClientMock
}))

import { createThreadActions } from './chat-store-thread-actions'
import { stopTurnCompletionPoll } from './chat-store-schedulers'

describe('createThreadActions recovery', () => {
  beforeEach(() => {
    registryMock.getProvider.mockReset()
    runtimeClientMock.getSettings.mockReset()
    stopTurnCompletionPoll()
  })

  it('shows a blank conversation immediately while the previous turn keeps running', async () => {
    const previousAbort = new AbortController()
    const previousThread = {
      id: 'thr_running',
      title: 'Running task',
      workspace: '/workspace',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    }
    const createdThread = {
      id: 'thr_new',
      title: 'New conversation',
      workspace: '/workspace',
      createdAt: '2026-08-01T00:00:01.000Z',
      updatedAt: '2026-08-01T00:00:01.000Z'
    }
    let resolveCreate!: (thread: typeof createdThread) => void
    const createResult = new Promise<typeof createdThread>((resolve) => {
      resolveCreate = resolve
    })
    const provider = {
      createThread: vi.fn(() => createResult),
      getThreadDetail: vi.fn(async (threadId: string) =>
        threadId === previousThread.id
          ? {
              blocks: [{ kind: 'user' as const, id: 'user_1', text: 'keep working' }],
              latestSeq: 1,
              threadStatus: 'running'
            }
          : { blocks: [], latestSeq: 0, threadStatus: 'idle' }
      ),
      subscribeThreadEvents: vi.fn(async () => undefined)
    }
    registryMock.getProvider.mockReturnValue(provider)
    runtimeClientMock.getSettings.mockResolvedValue({ workspaceRoot: '/workspace' })

    const refreshThreads = vi.fn(async () => undefined)
    const state = {
      runtimeConnection: 'ready',
      activeThreadId: previousThread.id,
      activeThreadGoal: null,
      activeThreadTodos: null,
      blocks: [{ kind: 'user', id: 'user_1', text: 'keep working' }],
      busy: true,
      codeWorkspaceRoots: ['/workspace'],
      threads: [previousThread],
      clawChannels: [],
      watchTurnCompletion: {},
      unreadThreadIds: {},
      currentTurnId: 'turn_1',
      currentTurnUserId: 'user_1',
      error: null,
      lastSeq: 1,
      liveAssistant: '',
      liveReasoning: '',
      queuedMessages: [],
      turnStartedAtByUserId: {},
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {},
      inspectorSelectedId: null,
      refreshThreads,
      probeRuntime: vi.fn(async () => undefined)
    } as unknown as ChatState
    const get: ChatStoreGet = () => state
    const set: ChatStoreSet = (partial) => {
      const update = typeof partial === 'function' ? partial(state) : partial
      Object.assign(state, update)
    }
    const sseAbortRef = { current: previousAbort as AbortController | null }
    const actions = createThreadActions({ set, get, sseAbortRef })
    state.createThread = actions.createThread
    state.selectThread = actions.selectThread

    const creating = actions.createThread()

    expect(state.activeThreadId).toBeNull()
    expect(state.blocks).toEqual([])
    expect(state.busy).toBe(false)
    expect(state.watchTurnCompletion).toEqual({ [previousThread.id]: true })
    expect(previousAbort.signal.aborted).toBe(true)
    expect(provider.createThread).not.toHaveBeenCalled()

    resolveCreate(createdThread)
    await creating

    expect(state.activeThreadId).toBe(createdThread.id)
    expect(provider.createThread).toHaveBeenCalledTimes(1)
    expect(refreshThreads).toHaveBeenCalledTimes(1)
    stopTurnCompletionPoll()
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
