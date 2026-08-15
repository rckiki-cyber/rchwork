import { chmod, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import type { MemoryCapabilityConfig } from '../contracts/capabilities.js'
import {
  MemoryDiagnostics,
  MemoryCreateRequest,
  MemoryRecord,
  MemoryUpdateRequest,
  type MemoryListFilter,
  type MemoryListResult
} from '../contracts/memory.js'
import {
  assertMemoryCaptureAllowed,
  assertMemoryContentHasNoSecrets,
  MemoryPolicyError,
  normalizeMemoryText
} from './memory-policy.js'

export interface MemoryStore {
  create(input: MemoryCreateRequest): Promise<MemoryRecord>
  update(id: string, patch: MemoryUpdateRequest): Promise<MemoryRecord>
  delete(id: string): Promise<MemoryRecord>
  purge(id: string): Promise<{ id: string; purged: true }>
  list(filter?: MemoryListFilter): Promise<MemoryRecord[]>
  listPage(filter?: MemoryListFilter): Promise<MemoryListResult>
  retrieve(input: { query: string; workspace?: string; project?: string; limit?: number }): Promise<MemoryRecord[]>
  diagnostics(): Promise<MemoryDiagnostics>
  setLastInjected(ids: string[]): void
}

export class FileMemoryStore implements MemoryStore {
  private lastInjectedIds: string[] = []

  constructor(
    private readonly options: {
      rootDir: string
      config: MemoryCapabilityConfig
      nowIso?: () => string
      idGenerator?: () => string
    }
  ) {}

  async create(input: MemoryCreateRequest): Promise<MemoryRecord> {
    await this.ensureRoot()
    const normalized = normalizeCreateInput(input)
    assertMemoryCaptureAllowed(normalized)
    const records = await this.readAll()
    const duplicate = records.find((record) => sameMemory(record, normalized))
    if (duplicate?.deletedAt && normalized.captureSource === 'automatic') {
      throw new MemoryPolicyError(
        'confirmation_required',
        'An equivalent memory was previously deleted and cannot be restored automatically.'
      )
    }
    const now = this.now()
    if (duplicate) {
      const revived = MemoryRecord.parse({
        ...duplicate,
        content: normalized.content,
        category: normalized.category,
        recallPolicy: normalized.recallPolicy === 'always' ? 'always' : duplicate.recallPolicy,
        captureSource: normalized.captureSource,
        workspace: normalized.workspace,
        project: normalized.project,
        sourceThreadId: normalized.sourceThreadId ?? duplicate.sourceThreadId,
        sourceTurnId: normalized.sourceTurnId ?? duplicate.sourceTurnId,
        origin: normalized.origin,
        sourceIterationId: normalized.sourceIterationId ?? duplicate.sourceIterationId,
        evidence: mergeEvidence(duplicate.evidence, normalized.evidence),
        tags: [...new Set([...duplicate.tags, ...normalized.tags])],
        confidence: Math.max(duplicate.confidence, normalized.confidence),
        disabledAt: undefined,
        deletedAt: undefined,
        updatedAt: now
      })
      await this.write(revived)
      return revived
    }
    const parsed = MemoryRecord.parse({
      id: this.options.idGenerator?.() ?? `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ...normalized,
      createdAt: now,
      updatedAt: now
    })
    await this.write(parsed)
    return parsed
  }

  async update(id: string, patch: MemoryUpdateRequest): Promise<MemoryRecord> {
    const current = await this.mustGet(id)
    const parsedPatch = MemoryUpdateRequest.parse(patch)
    if (parsedPatch.content !== undefined) {
      assertMemoryContentHasNoSecrets(parsedPatch.content)
    }
    const now = this.now()
    const scope = parsedPatch.scope ?? current.scope
    const workspace = parsedPatch.workspace ?? current.workspace
    const project = parsedPatch.project ?? current.project ?? workspace
    assertScopeContext(scope, workspace, project)
    const next = MemoryRecord.parse({
      ...current,
      ...(parsedPatch.content !== undefined ? { content: parsedPatch.content.trim() } : {}),
      ...(parsedPatch.scope !== undefined ? { scope: parsedPatch.scope } : {}),
      ...(parsedPatch.category !== undefined ? { category: parsedPatch.category } : {}),
      ...(parsedPatch.recallPolicy !== undefined ? { recallPolicy: parsedPatch.recallPolicy } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(parsedPatch.tags !== undefined ? { tags: normalizedTags(parsedPatch.tags) } : {}),
      ...(parsedPatch.confidence !== undefined ? { confidence: parsedPatch.confidence } : {}),
      ...(parsedPatch.disabled === true ? { disabledAt: current.disabledAt ?? now } : {}),
      ...(parsedPatch.disabled === false ? { disabledAt: undefined } : {}),
      ...(parsedPatch.restore === true ? { deletedAt: undefined } : {}),
      updatedAt: now
    })
    await this.write(next)
    return next
  }

  async delete(id: string): Promise<MemoryRecord> {
    const current = await this.mustGet(id)
    const now = this.now()
    const next = MemoryRecord.parse({
      ...current,
      deletedAt: current.deletedAt ?? now,
      updatedAt: now
    })
    await this.write(next)
    return next
  }

  async purge(id: string): Promise<{ id: string; purged: true }> {
    const current = await this.mustGet(id)
    if (!current.deletedAt) {
      throw new Error(`memory must be deleted before it can be permanently removed: ${id}`)
    }
    await rm(this.recordPath(current.id), { force: true })
    return { id: current.id, purged: true }
  }

  async list(filter: MemoryListFilter = {}): Promise<MemoryRecord[]> {
    return (await this.listPage(filter)).memories
  }

  async listPage(filter: MemoryListFilter = {}): Promise<MemoryListResult> {
    const records = await this.readAll()
    const filtered = records
      .filter((record) => filter.includeDeleted || filter.state === 'deleted' || !record.deletedAt)
      .filter((record) => inScope(record, filter.workspace, filter.project))
      .filter((record) => !filter.scope || record.scope === filter.scope)
      .filter((record) => !filter.category || record.category === filter.category)
      .filter((record) => !filter.state || memoryState(record) === filter.state)
      .filter((record) => !filter.query || scoreMemory(record, filter.query) > 0)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const total = filtered.length
    const offset = Math.max(0, Math.floor(filter.offset ?? 0))
    const limit = filter.limit === undefined
      ? undefined
      : Math.max(1, Math.min(500, Math.floor(filter.limit)))
    return {
      memories: limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit),
      total
    }
  }

  async retrieve(input: { query: string; workspace?: string; project?: string; limit?: number }): Promise<MemoryRecord[]> {
    if (!this.options.config.enabled) return []
    const limit = Math.max(
      1,
      Math.min(input.limit ?? this.options.config.maxInjectedRecords, this.options.config.maxInjectedRecords)
    )
    const active = (await this.list({ workspace: input.workspace, project: input.project }))
      .filter((record) => !record.disabledAt)
    // 排序必须以 id 收尾（确定性 tiebreaker）：updatedAt 可能在 turn 中途被
    // 学习线程刷新，仅用 updatedAt 排序会让同一查询在不同 model step 返回
    // 不同顺序，导致注入的 memory 指令漂移、破坏 provider 前缀缓存。
    const always = active
      .filter((record) => record.recallPolicy === 'always')
      .sort((a, b) =>
        b.confidence - a.confidence ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id)
      )
      .slice(0, Math.ceil(limit * 0.6))
    const relevant = active
      .filter((record) => record.recallPolicy === 'relevant')
      .map((record) => ({ record, score: scoreMemory(record, input.query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) =>
        b.score - a.score ||
        b.record.confidence - a.record.confidence ||
        b.record.updatedAt.localeCompare(a.record.updatedAt) ||
        a.record.id.localeCompare(b.record.id)
      )
      .map((entry) => entry.record)
    return [...always, ...relevant]
      .filter((record, index, values) => values.findIndex((candidate) => candidate.id === record.id) === index)
      .slice(0, limit)
  }

  async diagnostics(): Promise<MemoryDiagnostics> {
    const records = await this.readAll()
    return {
      enabled: this.options.config.enabled,
      rootDir: this.options.rootDir,
      activeCount: records.filter((record) => !record.deletedAt && !record.disabledAt).length,
      tombstoneCount: records.filter((record) => Boolean(record.deletedAt)).length,
      lastInjectedIds: [...this.lastInjectedIds]
    }
  }

  setLastInjected(ids: string[]): void {
    this.lastInjectedIds = [...ids]
  }

  private async mustGet(id: string): Promise<MemoryRecord> {
    const record = (await this.readAll()).find((candidate) => candidate.id === id)
    if (!record) throw new Error(`memory not found: ${id}`)
    return record
  }

  private async readAll(): Promise<MemoryRecord[]> {
    await this.ensureRoot()
    const entries = await readdir(this.options.rootDir).catch(() => [])
    const records = await Promise.all(entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => readFile(join(this.options.rootDir, entry), 'utf8')
        .then((text) => MemoryRecord.parse(JSON.parse(text)))
        .catch(() => null)))
    return records.filter((record): record is MemoryRecord => Boolean(record))
  }

  private async write(record: MemoryRecord): Promise<void> {
    const path = this.recordPath(record.id)
    await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`)
    await chmod(path, 0o600).catch(() => undefined)
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.options.rootDir, { recursive: true })
    await chmod(this.options.rootDir, 0o700).catch(() => undefined)
  }

  private recordPath(id: string): string {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) {
      throw new Error(`invalid memory id: ${id}`)
    }
    return join(this.options.rootDir, `${id}.json`)
  }

  private now(): string {
    return this.options.nowIso?.() ?? new Date().toISOString()
  }
}

function normalizeCreateInput(input: MemoryCreateRequest) {
  const parsed = MemoryCreateRequest.parse(input)
  const content = parsed.content.trim()
  const workspace = parsed.workspace?.trim() || undefined
  const project = parsed.project?.trim() || workspace
  assertScopeContext(parsed.scope, workspace, project)
  return {
    ...parsed,
    content,
    workspace,
    project,
    tags: normalizedTags(parsed.tags)
  }
}

function assertScopeContext(
  scope: MemoryRecord['scope'],
  workspace: string | undefined,
  project: string | undefined
): void {
  if (scope === 'workspace' && !workspace) {
    throw new Error('workspace is required for workspace-scoped memory')
  }
  if (scope === 'project' && !project) {
    throw new Error('project is required for project-scoped memory')
  }
}

function normalizedTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => normalizeMemoryText(tag)).filter(Boolean))]
}

function mergeEvidence(
  current: MemoryRecord['evidence'],
  incoming: MemoryRecord['evidence']
): MemoryRecord['evidence'] {
  const merged = new Map(current.map((item) => [item.sourceKey, item]))
  for (const item of incoming) merged.set(item.sourceKey, item)
  return [...merged.values()].slice(-20)
}

function sameMemory(record: MemoryRecord, input: ReturnType<typeof normalizeCreateInput>): boolean {
  if (record.scope !== input.scope) return false
  if (record.scope === 'workspace' && record.workspace !== input.workspace) return false
  if (record.scope === 'project' && (record.project ?? record.workspace) !== input.project) return false
  return normalizeMemoryText(record.content) === normalizeMemoryText(input.content)
}

function inScope(
  record: MemoryRecord,
  workspace: string | undefined,
  project: string | undefined
): boolean {
  if (record.scope === 'user') return true
  if (record.scope === 'workspace') return Boolean(workspace && record.workspace === workspace)
  const projectKey = project ?? workspace
  return Boolean(projectKey && (record.project ?? record.workspace) === projectKey)
}

function scoreMemory(record: MemoryRecord, query: string): number {
  const normalizedQuery = normalizeMemoryText(query)
  if (!normalizedQuery) return 0
  const normalizedText = normalizeMemoryText(`${record.content} ${record.tags.join(' ')}`)
  let score = normalizedText.includes(normalizedQuery) ? 4 : 0
  const queryTokens = memoryTokens(normalizedQuery)
  const textTokens = memoryTokens(normalizedText)
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      score += token.length >= 4 ? 1.5 : 1
    }
  }
  return score
}

function memoryTokens(value: string): Set<string> {
  const tokens = new Set<string>()
  for (const token of value.match(/[a-z0-9_]{2,}/g) ?? []) tokens.add(token)
  for (const run of value.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length <= 4) tokens.add(run)
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2))
    }
  }
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: 'word' }
    ) => { segment(value: string): Iterable<{ segment: string; isWordLike?: boolean }> }
  }).Segmenter
  if (Segmenter) {
    for (const part of new Segmenter('zh-CN', { granularity: 'word' }).segment(value)) {
      if (part.isWordLike && part.segment.length >= 2) tokens.add(part.segment)
    }
  }
  return tokens
}

function memoryState(record: MemoryRecord): 'active' | 'disabled' | 'deleted' {
  if (record.deletedAt) return 'deleted'
  if (record.disabledAt) return 'disabled'
  return 'active'
}
