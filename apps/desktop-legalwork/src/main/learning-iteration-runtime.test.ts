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

import {
  createLearningIterationRuntime,
  extractLearningThreadText,
  parseLearningModelResult,
  repairLearningModelJson
} from './learning-iteration-runtime'

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

describe('learning model result parsing', () => {
  it('repairs unescaped double quotes inside long Markdown string values', () => {
    const response = [
      'BEGIN_LEARNING_RESULT',
      '{',
      '  "title": "法律多源调研工作流",',
      '  "summary": "识别出稳定工作流",',
      '  "reportMarkdown": "# 报告\\\\n\\\\n用户要求"多源调研"，并询问"这个论文讲了什么"。",',
      '  "memories": [],',
      '  "skills": [],',
      '  "rejected": []',
      '}',
      'END_LEARNING_RESULT'
    ].join('\n')

    expect(parseLearningModelResult(response)).toMatchObject({
      title: '法律多源调研工作流',
      reportMarkdown: '# 报告\n\n用户要求"多源调研"，并询问"这个论文讲了什么"。'
    })
  })

  it('repairs raw line breaks and invalid backslash escapes inside strings', () => {
    const invalid = `{
  "title": "测试",
  "summary": "路径 C:\\legal\\quote
第二行",
  "reportMarkdown": "",
  "memories": [],
  "skills": [],
  "rejected": []
}`
    const repaired = repairLearningModelJson(invalid)
    const parsed = JSON.parse(repaired) as { summary: string }

    expect(parsed.summary).toBe('路径 C:\\legal\\quote\n第二行')
  })

  it('does not alter already valid learning JSON', () => {
    const valid = JSON.stringify({
      title: '测试',
      summary: '用户要求"多源调研"',
      reportMarkdown: '# 报告\n\n内容',
      memories: [],
      skills: [],
      rejected: []
    })

    expect(repairLearningModelJson(valid)).toBe(valid)
    expect(parseLearningModelResult(valid).summary).toBe('用户要求"多源调研"')
  })
})

describe('learning source hygiene', () => {
  it('keeps the real knowledge-base question and excludes RAG context and assistant output', () => {
    const detail = {
      turns: [{
        items: [
          {
            kind: 'user_message',
            text: [
              '你是一个专业的法律知识助手。',
              '## RAG 检索上下文',
              '【知识库检索结果】',
              '[files › 实习简历]',
              '这里是大量不应进入学习语料的检索内容',
              '## 用户问题',
              '知识库里有什么？',
              '',
              '请基于检索到的内容给出准确回答。'
            ].join('\n')
          },
          {
            kind: 'assistant_text',
            text: '助手根据检索内容推断出的身份、偏好和履历不得作为用户证据。'
          },
          {
            kind: 'user_message',
            text: '在么'
          }
        ]
      }]
    }

    expect(extractLearningThreadText(detail)).toBe('用户：知识库里有什么？')
  })

  it('does not let a stale learning thread block future iterations', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'legalwork-learning-stale-thread-'))
    tempRoots.push(dataDir)
    const appSettings = settings(dataDir)
    const runtimeRequest = emptyRuntimeRequest()
    runtimeRequest.mockImplementation(async (_settings: AppSettingsV1, path: string) => {
      if (path === '/data-compliance/tasks') {
        return { ok: true, status: 200, body: JSON.stringify({ items: [] }) }
      }
      if (path.startsWith('/v1/threads')) {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            threads: [{
              id: 'thr_stale',
              title: '[Learning iteration] stale-run',
              status: 'running'
            }]
          })
        }
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
    await vi.waitFor(async () => {
      expect((await runtime.status()).message).toBe('本周期没有可学习的新数据')
    })
    runtime.stop()
  })
})
