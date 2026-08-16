import type { TurnItem } from '../contracts/items.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { RuntimeEventRecorder } from './runtime-event-recorder.js'

function abortOpenItem(item: TurnItem, finishedAt: string): TurnItem {
  if (item.kind === 'approval' && item.status === 'pending') {
    return { ...item, status: 'expired', finishedAt }
  }
  if (item.kind === 'user_input' && item.status === 'pending') {
    return { ...item, status: 'cancelled', finishedAt }
  }
  if (item.status === 'pending' || item.status === 'running') {
    return { ...item, status: 'aborted', finishedAt } as TurnItem
  }
  return item
}

/**
 * A process restart destroys every in-memory AbortController. Persisted
 * running turns therefore cannot still be alive and must be reconciled before
 * the HTTP server accepts clients, otherwise the UI replays a permanent zombie.
 */
export async function recoverInterruptedTurns(input: {
  threadStore: ThreadStore
  sessionStore: SessionStore
  events: RuntimeEventRecorder
  nowIso: () => string
}): Promise<number> {
  const summaries = await input.threadStore.list({
    limit: 10_000,
    includeArchived: true,
    includeSide: true
  })
  let recovered = 0
  for (const summary of summaries) {
    if (summary.status !== 'running') continue
    const thread = await input.threadStore.get(summary.id)
    if (!thread) continue
    const interruptedTurns = thread.turns.filter((turn) => turn.status === 'queued' || turn.status === 'running')
    if (interruptedTurns.length === 0) {
      await input.threadStore.upsert({ ...thread, status: 'idle', updatedAt: input.nowIso() })
      continue
    }
    const finishedAt = input.nowIso()
    const interruptedIds = new Set(interruptedTurns.map((turn) => turn.id))
    const persistedItems = await input.sessionStore.loadItems(thread.id)
    const recoveredItems = persistedItems.map((item) =>
      interruptedIds.has(item.turnId) ? abortOpenItem(item, finishedAt) : item
    )
    await input.sessionStore.rewriteItems(thread.id, recoveredItems)
    const session = await input.sessionStore.loadSession(thread.id)
    if (session && interruptedIds.has(session.turnId)) {
      await input.sessionStore.upsertSession({
        ...session,
        items: recoveredItems,
        updatedAt: finishedAt,
        closed: true
      })
    }
    await input.threadStore.upsert({
      ...thread,
      status: 'idle',
      updatedAt: finishedAt,
      turns: thread.turns.map((turn) =>
        interruptedIds.has(turn.id)
          ? {
              ...turn,
              status: 'aborted' as const,
              finishedAt,
              items: turn.items.map((item) => abortOpenItem(item, finishedAt)),
              error: 'Runtime restarted before this turn completed.'
            }
          : turn
      )
    })
    for (const turn of interruptedTurns) {
      await input.events.record({
        kind: 'turn_aborted',
        threadId: thread.id,
        turnId: turn.id,
        status: 'aborted',
        message: 'Runtime restarted before this turn completed.'
      })
      recovered += 1
    }
  }
  return recovered
}
