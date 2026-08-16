import { describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { makeAssistantReasoningItem, makeToolCallItem } from '../domain/item.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'
import { recoverInterruptedTurns } from './interrupted-turn-recovery.js'

describe('recoverInterruptedTurns', () => {
  it('aborts persisted work that cannot survive a runtime restart', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const nowIso = () => '2026-08-12T11:00:00.000Z'
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.allocateSeq(threadId),
      nowIso
    })
    const reasoning = makeAssistantReasoningItem({
      id: 'reasoning-1', turnId: 'turn-1', threadId: 'thread-1', text: '内部推理', status: 'running'
    })
    const tool = makeToolCallItem({
      id: 'tool-1', turnId: 'turn-1', threadId: 'thread-1', callId: 'call-1', toolName: 'search', arguments: {}, status: 'running'
    })
    await threadStore.upsert({
      id: 'thread-1', title: 'research', workspace: '/tmp', model: 'test', mode: 'agent',
      status: 'running', approvalPolicy: 'on-request', sandboxMode: 'workspace-write', relation: 'primary',
      createdAt: nowIso(), updatedAt: nowIso(),
      turns: [{
        id: 'turn-1', threadId: 'thread-1', status: 'running', prompt: 'research', steering: [],
        createdAt: nowIso(), startedAt: nowIso(), items: [reasoning, tool], attachmentIds: [], activeSkillIds: [], injectedMemoryIds: []
      }]
    })
    await sessionStore.appendItem('thread-1', reasoning)
    await sessionStore.appendItem('thread-1', tool)

    await expect(recoverInterruptedTurns({ threadStore, sessionStore, events, nowIso })).resolves.toBe(1)
    expect(await threadStore.get('thread-1')).toMatchObject({
      status: 'idle',
      turns: [{ status: 'aborted', finishedAt: nowIso() }]
    })
    expect(await sessionStore.loadItems('thread-1')).toEqual([
      expect.objectContaining({ id: 'reasoning-1', status: 'aborted' }),
      expect.objectContaining({ id: 'tool-1', status: 'aborted' })
    ])
    expect(await sessionStore.loadEventsSince('thread-1', 0)).toEqual([
      expect.objectContaining({ kind: 'turn_aborted', turnId: 'turn-1' })
    ])
  })
})
