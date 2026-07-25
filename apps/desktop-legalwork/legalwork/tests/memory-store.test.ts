import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { buildMemoryToolProviders } from '../src/adapters/tool/memory-tool-provider.js'
import { LegalworkCapabilitiesConfig, type MemoryCapabilityConfig } from '../src/contracts/capabilities.js'
import { FileMemoryStore } from '../src/memory/memory-store.js'
import type { ModelClient, ModelRequest } from '../src/ports/model-client.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'
import { buildHarness, readJson } from './http-server-test-harness.js'

describe('Memory store and recall', () => {
  let dir = ''
  let nextId = 1

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legalwork-memory-'))
    nextId = 1
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores scoped memories, retrieves relevant records, and keeps tombstones', async () => {
    const store = createStore()
    const memory = await store.create({
      content: 'User prefers pnpm for frontend projects',
      scope: 'workspace',
      workspace: '/tmp/ws',
      tags: ['frontend'],
      confidence: 0.9
    })
    await store.create({
      content: 'Unrelated backend preference',
      scope: 'workspace',
      workspace: '/tmp/other'
    })

    expect((await store.retrieve({ query: 'frontend pnpm preference', workspace: '/tmp/ws', limit: 3 })).map((item) => item.id)).toEqual([memory.id])
    expect(await createStore({ enabled: false }).retrieve({ query: 'pnpm', workspace: '/tmp/ws', limit: 3 })).toEqual([])

    await store.update(memory.id, { disabled: true })
    expect(await store.retrieve({ query: 'pnpm', workspace: '/tmp/ws', limit: 3 })).toEqual([])
    await store.update(memory.id, { disabled: false, content: 'User strongly prefers pnpm' })
    expect(await store.retrieve({ query: 'pnpm', workspace: '/tmp/ws', limit: 3 })).toHaveLength(1)
    await store.delete(memory.id)
    expect(await store.retrieve({ query: 'pnpm', workspace: '/tmp/ws', limit: 3 })).toEqual([])
    expect((await store.list({ workspace: '/tmp/ws', includeDeleted: true })).find((item) => item.id === memory.id)?.deletedAt).toBeTruthy()
  })

  it('persists auditable learning-iteration provenance', async () => {
    const store = createStore()
    const memory = await store.create({
      content: 'User prefers concise Chinese headings',
      scope: 'user',
      category: 'preference',
      captureSource: 'automatic',
      origin: 'learning-iteration',
      sourceIterationId: '2026-07-23-0800-abcd1234',
      evidence: [
        { sourceKey: 'thread:one', note: 'Explicit preference' },
        { sourceKey: 'thread:two', note: 'Repeated preference' }
      ]
    })

    expect(memory).toMatchObject({
      origin: 'learning-iteration',
      sourceIterationId: '2026-07-23-0800-abcd1234',
      evidence: [
        { sourceKey: 'thread:one' },
        { sourceKey: 'thread:two' }
      ]
    })
    expect((await store.list({ scope: 'user' }))[0]).toMatchObject({
      origin: 'learning-iteration',
      evidence: expect.arrayContaining([{ sourceKey: 'thread:one', note: 'Explicit preference' }])
    })
  })

  it('exposes memory API routes with diagnostics', async () => {
    const h = buildHarness()
    h.runtime.memoryStore = createStore()
    const created = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/memory', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Remember pnpm',
          scope: 'workspace',
          workspace: '/tmp/ws',
          category: 'preference'
        })
      })
    )
    expect(created.status).toBe(201)
    const body = await readJson(created) as { memory: { id: string } }

    const list = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/memory?workspace=/tmp/ws', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect((await readJson(list)) as { memories: unknown[]; total: number }).toMatchObject({
      memories: [expect.any(Object)],
      total: 1
    })

    await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/memory', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Use a four-step review workflow',
          scope: 'workspace',
          workspace: '/tmp/ws',
          category: 'workflow'
        })
      })
    )
    const filtered = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/memory?workspace=/tmp/ws&query=pnpm&category=preference&scope=workspace&state=active&limit=1&offset=0', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(await readJson(filtered)).toMatchObject({
      total: 1,
      memories: [{ id: body.memory.id, category: 'preference' }]
    })

    const disabled = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/memory/${body.memory.id}`, {
        method: 'PATCH',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: true })
      })
    )
    expect(disabled.status).toBe(200)
    const deleted = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/memory/${body.memory.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(deleted.status).toBe(200)
    const diagnostics = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/memory/diagnostics', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(await readJson(diagnostics)).toMatchObject({ tombstoneCount: 1 })

    const restored = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/memory/${body.memory.id}`, {
        method: 'PATCH',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ restore: true, disabled: false })
      })
    )
    expect((await readJson(restored) as { memory: { deletedAt?: string } }).memory.deletedAt).toBeUndefined()
    await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/memory/${body.memory.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const purged = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/memory/${body.memory.id}?permanent=true`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(await readJson(purged)).toEqual({ id: body.memory.id, purged: true })

    const rejectedSecret = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/memory', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'password: correct-horse-battery-staple',
          scope: 'user',
          category: 'preference',
          captureSource: 'manual'
        })
      })
    )
    expect(rejectedSecret.status).toBe(400)
  })

  it('auto-saves safe high-confidence memories without a generic tool approval', async () => {
    const store = createStore()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildMemoryToolProviders(store))
    })
    let approvals = 0
    const result = await host.execute({
      callId: 'call_1',
      toolName: 'memory_create',
      arguments: {
        content: 'Use pnpm',
        workspace: '/tmp/ws',
        category: 'preference',
        confidence: 0.9,
        capture_source: 'automatic'
      }
    }, {
      threadId: 'thr_1',
      turnId: 'turn_1',
      workspace: '/tmp/ws',
      approvalPolicy: 'on-request',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => {
        approvals += 1
        return 'allow'
      }
    })

    expect(approvals).toBe(0)
    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(await store.list({ workspace: '/tmp/ws' })).toHaveLength(1)

    const search = await host.execute({
      callId: 'call_2',
      toolName: 'memory_search',
      arguments: { query: 'pnpm', scope: 'workspace' }
    }, {
      threadId: 'thr_1',
      turnId: 'turn_2',
      workspace: '/tmp/ws',
      approvalPolicy: 'on-request',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => {
        approvals += 1
        return 'allow'
      }
    })
    expect(search.item).toMatchObject({
      kind: 'tool_result',
      isError: false,
      output: {
        total: 1,
        memories: [{ content: 'Use pnpm' }]
      }
    })
    expect(approvals).toBe(0)
  })

  it('requires confirmation for low-confidence or sensitive automatic captures and rejects secrets', async () => {
    const store = createStore()
    await expect(store.create({
      content: '用户可能喜欢羽毛球',
      scope: 'user',
      category: 'interest',
      captureSource: 'automatic',
      confidence: 0.9
    })).rejects.toMatchObject({ code: 'confirmation_required' })
    await expect(store.create({
      content: '客户手机号 13800138000',
      scope: 'workspace',
      workspace: '/tmp/ws',
      category: 'profile',
      captureSource: 'automatic',
      confidence: 0.9
    })).rejects.toMatchObject({ code: 'confirmation_required' })
    await expect(store.create({
      content: 'API key: sk-1234567890abcdef',
      scope: 'user',
      category: 'preference',
      captureSource: 'explicit'
    })).rejects.toMatchObject({ code: 'secret_rejected' })
    await expect(store.create({
      content: 'Token 为 abcdefghijklmnopqrstuvwxyz',
      scope: 'user',
      category: 'preference',
      captureSource: 'confirmed'
    })).rejects.toMatchObject({ code: 'secret_rejected' })
    await expect(store.create({
      content: '客户手机号 13800138000',
      scope: 'workspace',
      workspace: '/tmp/ws',
      category: 'matter',
      captureSource: 'confirmed'
    })).resolves.toMatchObject({ category: 'matter' })
  })

  it('supports Chinese recall, always memories, configured limits, deduplication, and project isolation', async () => {
    const store = createStore({ maxInjectedRecords: 2 })
    const always = await store.create({
      content: '用户要求法律文书默认使用简体中文',
      scope: 'user',
      category: 'workflow',
      recallPolicy: 'always',
      captureSource: 'automatic',
      confidence: 0.95
    })
    const chinese = await store.create({
      content: '用户偏好简洁的合同审查意见',
      scope: 'workspace',
      workspace: '/tmp/ws',
      category: 'preference',
      recallPolicy: 'relevant',
      captureSource: 'automatic',
      confidence: 0.9
    })
    await store.create({
      content: '项目甲采用固定证据目录格式',
      scope: 'project',
      workspace: '/tmp/project-a',
      project: '/tmp/project-a',
      category: 'project',
      captureSource: 'confirmed'
    })

    const recalled = await store.retrieve({
      query: '请给出简洁的合同审查',
      workspace: '/tmp/ws'
    })
    expect(recalled.map((record) => record.id)).toEqual([always.id, chinese.id])
    expect(await store.retrieve({
      query: '证据目录',
      workspace: '/tmp/project-b',
      project: '/tmp/project-b'
    })).toEqual([always])

    const duplicate = await store.create({
      content: '  用户偏好简洁的合同审查意见  ',
      scope: 'workspace',
      workspace: '/tmp/ws',
      category: 'preference',
      captureSource: 'explicit',
      confidence: 1
    })
    expect(duplicate.id).toBe(chinese.id)
    expect(await store.list({ workspace: '/tmp/ws' })).toHaveLength(2)

    await store.create({
      content: '合同摘要使用三段式结构',
      scope: 'workspace',
      workspace: '/tmp/confidence',
      category: 'workflow',
      confidence: 0.81
    })
    const highConfidence = await store.create({
      content: '合同摘要使用要点式结构',
      scope: 'workspace',
      workspace: '/tmp/confidence',
      category: 'workflow',
      confidence: 0.98
    })
    expect((await store.retrieve({
      query: '合同摘要结构',
      workspace: '/tmp/confidence'
    })).map((record) => record.id)).toEqual([always.id, highConfidence.id])
  })

  it('loads legacy records, filters list pages, restores tombstones, and permanently purges atomically written files', async () => {
    const memoryDir = join(dir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, 'mem_legacy.json'), JSON.stringify({
      id: 'mem_legacy',
      content: 'Legacy preference',
      scope: 'workspace',
      workspace: '/tmp/ws',
      tags: [],
      confidence: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }))
    const store = createStore()
    const legacy = (await store.list({ workspace: '/tmp/ws' }))[0]
    expect(legacy).toMatchObject({
      category: 'other',
      recallPolicy: 'relevant',
      captureSource: 'legacy'
    })

    const created = await store.create({
      content: 'Remember Chinese drafting conventions',
      scope: 'workspace',
      workspace: '/tmp/ws',
      category: 'workflow',
      captureSource: 'manual'
    })
    const page = await store.listPage({
      workspace: '/tmp/ws',
      category: 'workflow',
      query: 'drafting',
      state: 'active',
      limit: 1
    })
    expect(page).toMatchObject({ total: 1, memories: [{ id: created.id }] })
    expect((await stat(memoryDir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(memoryDir, `${created.id}.json`))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(memoryDir, `${created.id}.json`), 'utf8'))).toMatchObject({
      id: created.id
    })

    await expect(store.purge(created.id)).rejects.toThrow('memory must be deleted')
    await store.delete(created.id)
    expect((await store.listPage({ workspace: '/tmp/ws', state: 'deleted' })).total).toBe(1)
    await store.update(created.id, { restore: true })
    expect((await store.list({ workspace: '/tmp/ws' })).some((record) => record.id === created.id)).toBe(true)
    await store.delete(created.id)
    await expect(store.purge(created.id)).resolves.toEqual({ id: created.id, purged: true })
    await expect(store.purge(created.id)).rejects.toThrow('memory not found')
  })

  it('injects relevant memories into AgentLoop metadata and stops after deletion', async () => {
    const store = createStore()
    const memory = await store.create({
      content: 'Use pnpm when touching frontend code',
      scope: 'workspace',
      workspace: '/tmp/ws'
    })
    const seenRequests: ModelRequest[] = []
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequests.push(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, { memoryStore: store })
    await bootstrapThread(h, { workspace: '/tmp/ws', request: { prompt: 'frontend pnpm setup?' } })

    await h.loop.runTurn(h.threadId, h.turnId)

    expect(seenRequests.at(-1)?.contextInstructions?.join('\n')).toContain(memory.id)
    expect((await h.turns.getTurn(h.threadId, h.turnId))?.injectedMemoryIds).toEqual([memory.id])
    expect((await store.diagnostics()).lastInjectedIds).toEqual([memory.id])

    await store.delete(memory.id)
    const h2 = makeHarness(model, { memoryStore: store })
    await bootstrapThread(h2, { workspace: '/tmp/ws', request: { prompt: 'frontend pnpm setup?' } })
    await h2.loop.runTurn(h2.threadId, h2.turnId)
    const finalInstructions = seenRequests.at(-1)?.contextInstructions?.join('\n') ?? ''
    expect(finalInstructions).not.toContain(memory.id)
    expect(finalInstructions).toContain('Shell runtime:')
  })

  function createStore(overrides: Partial<MemoryCapabilityConfig> = {}) {
    return new FileMemoryStore({
      rootDir: join(dir, 'memory'),
      config: memoryConfig(overrides),
      nowIso: () => '2026-06-03T00:00:00.000Z',
      idGenerator: () => `mem_${nextId++}`
    })
  }

  function memoryConfig(overrides: Partial<MemoryCapabilityConfig> = {}) {
    return LegalworkCapabilitiesConfig.parse({
      memory: {
        enabled: true,
        ...overrides
      }
    }).memory
  }
})
