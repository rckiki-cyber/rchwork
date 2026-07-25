import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultLearningIterationSettings,
  defaultLegalworkRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsV1
} from '../shared/app-settings'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/legalwork-learning-test-app',
    getPath: () => '/tmp/legalwork-learning-test-user-data'
  }
}))

vi.mock('./services/skill-service', () => ({
  USER_INSTALLED_SKILL_ROOT: '/tmp/legalwork-learning-test-skills',
  listGuiSkills: vi.fn(async () => ({ ok: true, skills: [], validationErrors: [] })),
  readGuiSkillFile: vi.fn()
}))

import { createLearningIterationRuntime } from './learning-iteration-runtime'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

function settings(dataDir: string): AppSettingsV1 {
  return {
    version: 1,
    locale: 'zh',
    theme: 'system',
    uiFontScale: 'small',
    provider: defaultModelProviderSettings(),
    agents: {
      legalwork: {
        ...defaultLegalworkRuntimeSettings(),
        dataDir
      }
    },
    workspaceRoot: dataDir,
    log: { enabled: false, retentionDays: 2 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: defaultScheduleSettings(),
    learningIteration: {
      ...defaultLearningIterationSettings(),
      idleMinutes: 5
    },
    guiUpdate: { channel: 'stable' }
  }
}

function emptyRuntimeRequest() {
  return vi.fn(async (_settings: AppSettingsV1, path: string) => {
    if (path.startsWith('/v1/threads')) {
      return { ok: true, status: 200, body: JSON.stringify({ threads: [] }) }
    }
    if (path.startsWith('/v1/memory')) {
      return { ok: true, status: 200, body: JSON.stringify({ memories: [] }) }
    }
    if (path === '/v1/knowledge/tree') {
      return { ok: true, status: 200, body: JSON.stringify({ nodes: [] }) }
    }
    return { ok: false, status: 404, body: 'not found' }
  })
}

describe('LearningIterationRuntime scheduling', () => {
  it('does not create an empty report when no source changed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'legalwork-learning-empty-'))
    tempRoots.push(dataDir)
    const appSettings = settings(dataDir)
    const runtime = createLearningIterationRuntime({
      store: { load: vi.fn(async () => appSettings) } as never,
      runtimeRequest: emptyRuntimeRequest(),
      getSystemIdleSeconds: () => 60 * 60,
      getExternalBusy: async () => false,
      logError: vi.fn()
    })
    runtime.sync(appSettings)
    await vi.waitFor(async () => {
      expect((await runtime.status()).message).toBe('本周期没有可学习的新数据')
    })
    expect((await runtime.list()).ok).toBe(true)
    const list = await runtime.list()
    if (list.ok) expect(list.records).toEqual([])
    runtime.stop()
  })

  it('does not let a manual check bypass a successful local-day quota', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'legalwork-learning-daily-'))
    tempRoots.push(dataDir)
    const now = new Date('2026-07-23T08:00:00.000Z')
    const localDay = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-')
    const stateRoot = join(dataDir, 'learning-iterations')
    await mkdir(stateRoot, { recursive: true })
    await writeFile(join(stateRoot, 'state.json'), JSON.stringify({
      version: 1,
      sourceHashes: {},
      lastSuccessfulAt: now.toISOString(),
      lastCheckedAt: now.toISOString(),
      lastLocalDay: localDay,
      lastRetryAt: '',
      retryCount: 0,
      baselineComplete: true
    }), 'utf8')
    const appSettings = settings(dataDir)
    const runtime = createLearningIterationRuntime({
      store: { load: vi.fn(async () => appSettings) } as never,
      runtimeRequest: emptyRuntimeRequest(),
      getSystemIdleSeconds: () => 60 * 60,
      getExternalBusy: async () => false,
      logError: vi.fn(),
      now: () => now
    })
    runtime.sync(appSettings)
    await runtime.queue()
    await vi.waitFor(async () => {
      expect((await runtime.status()).message).toBe('今日已有成功记录，请在下一个自然日再检查')
    })
    runtime.stop()
  })

  it('waits while a data-compliance task is pending', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'legalwork-learning-compliance-busy-'))
    tempRoots.push(dataDir)
    const appSettings = settings(dataDir)
    const runtimeRequest = emptyRuntimeRequest()
    runtimeRequest.mockImplementation(async (_settings: AppSettingsV1, path: string) => {
      if (path === '/data-compliance/tasks') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({ items: [{ id: 'compliance-1', status: 'pending' }] })
        }
      }
      if (path.startsWith('/v1/threads')) {
        return { ok: true, status: 200, body: JSON.stringify({ threads: [] }) }
      }
      if (path.startsWith('/v1/memory')) {
        return { ok: true, status: 200, body: JSON.stringify({ memories: [] }) }
      }
      if (path === '/v1/knowledge/tree') {
        return { ok: true, status: 200, body: JSON.stringify({ nodes: [] }) }
      }
      return { ok: false, status: 404, body: 'not found' }
    })
    const runtime = createLearningIterationRuntime({
      store: { load: vi.fn(async () => appSettings) } as never,
      runtimeRequest,
      getSystemIdleSeconds: () => 60 * 60,
      getExternalBusy: async () => false,
      logError: vi.fn()
    })
    runtime.sync(appSettings)
    await runtime.queue()
    await vi.waitFor(async () => {
      const status = await runtime.status()
      expect(status.status).toBe('waiting')
      expect(status.message).toBe('正在等待所有任务结束并达到空闲条件')
    })
    expect(runtimeRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      '/v1/knowledge/tree',
      expect.anything()
    )
    runtime.stop()
  })
})
