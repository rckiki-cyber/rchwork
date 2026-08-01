import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../src/adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../src/domain/thread.js'
import { UsageService } from '../src/services/usage-service.js'
import {
  seedUsageCarryover,
  shouldAwaitPkulawMcpInitialization,
  waitForAtMost
} from '../src/server/runtime-factory.js'
import type { UsageSnapshot } from '../src/contracts/usage.js'
import type { LegalworkCapabilitiesConfig } from '../src/contracts/capabilities.js'

function usage(overrides: Partial<UsageSnapshot>): UsageSnapshot {
  const promptTokens = overrides.promptTokens ?? 10
  const completionTokens = overrides.completionTokens ?? 5
  const cacheHitTokens = overrides.cacheHitTokens ?? 0
  const cacheMissTokens = overrides.cacheMissTokens ?? Math.max(promptTokens - cacheHitTokens, 0)
  const cacheTotal = cacheHitTokens + cacheMissTokens
  return {
    promptTokens,
    completionTokens,
    totalTokens: overrides.totalTokens ?? promptTokens + completionTokens,
    cachedTokens: overrides.cachedTokens ?? cacheHitTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRate: cacheTotal === 0 ? null : cacheHitTokens / cacheTotal,
    turns: overrides.turns ?? 1,
    ...(overrides.costUsd !== undefined ? { costUsd: overrides.costUsd } : {})
  }
}

describe('runtime factory usage carryover', () => {
  it('seeds runtime usage from the latest persisted cumulative usage event per thread', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const usageService = new UsageService()
    await threadStore.upsert(createThreadRecord({
      id: 'thr_seed',
      title: 'Seeded thread',
      workspace: '/tmp/project',
      model: 'deepseek-chat'
    }))
    await sessionStore.appendEvent('thr_seed', {
      kind: 'usage',
      seq: 2,
      timestamp: '2026-06-02T09:00:00.000Z',
      threadId: 'thr_seed',
      usage: usage({ promptTokens: 20, completionTokens: 5, cacheHitTokens: 10, cacheMissTokens: 10, turns: 1 })
    })
    await sessionStore.appendEvent('thr_seed', {
      kind: 'usage',
      seq: 5,
      timestamp: '2026-06-02T09:05:00.000Z',
      threadId: 'thr_seed',
      usage: usage({ promptTokens: 80, completionTokens: 20, cacheHitTokens: 72, cacheMissTokens: 8, turns: 3 })
    })

    await seedUsageCarryover({ threadStore, sessionStore, usageService })

    expect(usageService.forThread('thr_seed')).toMatchObject({
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: 100,
      cacheHitTokens: 72,
      cacheMissTokens: 8,
      turns: 3
    })
    expect(usageService.cacheSnapshot('thr_seed')).toMatchObject({
      hits: 72,
      misses: 8,
      hitRate: 0.9
    })
  })
})

describe('runtime factory MCP readiness', () => {
  const mcp = {
    enabled: true,
    servers: {
      'pkulaw-law-search': {
        enabled: true,
        transport: 'streamable-http',
        url: 'https://mcp.example.test/pkulaw',
        args: [],
        headers: {},
        env: {},
        trustScope: 'user',
        trustedWorkspaceRoots: [],
        timeoutMs: 30_000
      }
    },
    search: {
      enabled: false,
      mode: 'auto',
      autoThresholdToolCount: 24,
      topKDefault: 5,
      topKMax: 10,
      minScore: 0.15,
      bm25: { k1: 1.2, b: 0.75 }
    }
  } satisfies LegalworkCapabilitiesConfig['mcp']

  it('waits for configured PKULaw only on legal-research turns', () => {
    expect(shouldAwaitPkulawMcpInitialization('请进行多源调研，并优先使用北大法宝', mcp)).toBe(true)
    expect(shouldAwaitPkulawMcpInitialization('整理当前目录中的 TypeScript 文件', mcp)).toBe(false)
  })

  it('never blocks the turn beyond the supplied readiness budget', async () => {
    const never = new Promise<void>(() => undefined)
    const startedAt = Date.now()

    await expect(waitForAtMost(never, 20)).resolves.toBe('timeout')
    expect(Date.now() - startedAt).toBeLessThan(250)
    await expect(waitForAtMost(Promise.resolve(), 20)).resolves.toBe('ready')
  })
})
