import { describe, expect, it } from 'vitest'
import type { NormalizedThread } from '../agent/types'
import type { BrowserStorageLike } from './browser-storage'
import {
  MAX_CACHED_SIDEBAR_THREADS,
  normalizeSidebarThreadCache,
  readSidebarThreadCache,
  saveSidebarThreadCache
} from './sidebar-thread-cache'

function memoryStorage(): BrowserStorageLike {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  }
}

function thread(id: string, overrides: Partial<NormalizedThread> = {}): NormalizedThread {
  return {
    id,
    title: overrides.title ?? `Thread ${id}`,
    updatedAt: overrides.updatedAt ?? '2026-08-10T00:00:00.000Z',
    model: overrides.model ?? 'deepseek-v4-flash',
    mode: overrides.mode ?? 'agent',
    workspace: overrides.workspace ?? '/Users/example/workspace',
    ...overrides
  }
}

describe('sidebar thread cache', () => {
  it('restores thread summaries needed by the sidebar', () => {
    const storage = memoryStorage()
    saveSidebarThreadCache([
      thread('thr_1', {
        archived: true,
        relation: 'fork',
        forkedFromThreadId: 'thr_parent',
        forkedFromTitle: 'Parent'
      })
    ], storage)

    expect(readSidebarThreadCache(storage)).toEqual([
      expect.objectContaining({
        id: 'thr_1',
        title: 'Thread thr_1',
        archived: true,
        relation: 'fork',
        forkedFromThreadId: 'thr_parent',
        forkedFromTitle: 'Parent'
      })
    ])
  })

  it('does not persist stale running state, message previews, goals, or todos', () => {
    const storage = memoryStorage()
    saveSidebarThreadCache([
      thread('thr_running', {
        status: 'running',
        latestTurnId: 'turn_1',
        latestTurnStatus: 'running',
        preview: 'sensitive message body',
        goal: {
          threadId: 'thr_running',
          objective: 'private objective',
          status: 'active',
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:00.000Z'
        }
      })
    ], storage)

    const [restored] = readSidebarThreadCache(storage)
    expect(restored.status).toBeUndefined()
    expect(restored.latestTurnId).toBeUndefined()
    expect(restored.latestTurnStatus).toBeUndefined()
    expect(restored.preview).toBeUndefined()
    expect(restored.goal).toBeUndefined()
    expect(restored.todos).toBeUndefined()
  })

  it('ignores malformed and duplicate entries and caps cache size', () => {
    const values = Array.from({ length: MAX_CACHED_SIDEBAR_THREADS + 10 }, (_, index) =>
      thread(`thr_${index}`)
    )
    values.splice(1, 0, thread('thr_0'), { id: '', title: '' } as NormalizedThread)

    const cache = normalizeSidebarThreadCache({ threads: values })

    expect(cache.threads).toHaveLength(MAX_CACHED_SIDEBAR_THREADS)
    expect(new Set(cache.threads.map((item) => item.id)).size).toBe(MAX_CACHED_SIDEBAR_THREADS)
  })

  it('fails closed when storage contains invalid JSON', () => {
    const storage: BrowserStorageLike = {
      getItem: () => '{invalid',
      setItem: () => undefined
    }

    expect(readSidebarThreadCache(storage)).toEqual([])
  })
})
