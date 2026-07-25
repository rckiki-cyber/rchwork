import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  containsSecret,
  containsSensitiveIdentifier
} from '../../legalwork/src/memory/memory-policy.js'
import type { AppSettingsV1 } from '../shared/app-settings'
import { getLegalworkRuntimeSettings } from '../shared/app-settings'
import type {
  LearningIterationActionResult,
  LearningIterationCounts,
  LearningIterationDetailResult,
  LearningIterationListResult,
  LearningIterationRecordSummary,
  LearningIterationRuntimeStatus
} from '../shared/ds-gui-api'
import type { JsonSettingsStore } from './settings-store'
import { resolveLegalworkDataDir } from './legalwork-process'
import {
  latestAssistantText,
  parseJsonObject,
  runtimeErrorMessage,
  sleep,
  type RuntimeRequestFn,
  type ThreadDetailJson
} from './schedule-runtime-helpers'
import {
  listGuiSkills,
  readGuiSkillFile,
  USER_INSTALLED_SKILL_ROOT
} from './services/skill-service'

const POLL_INTERVAL_MS = 5 * 60_000
const TURN_TIMEOUT_MS = 30 * 60_000
const MAX_SOURCE_CHARS = 200_000
const MAX_THREADS = 50
const MAX_KNOWLEDGE_FILES = 25
const MAX_MEMORY_AND_SKILLS = 100
const MAX_SINGLE_SOURCE_CHARS = 60_000
const LEARNING_THREAD_TITLE_PREFIX = '[Learning iteration]'
const RESULT_BEGIN = 'BEGIN_LEARNING_RESULT'
const RESULT_END = 'END_LEARNING_RESULT'
const AUTOMATIC_MEMORY_CATEGORIES = new Set([
  'profile',
  'preference',
  'workflow',
  'project'
])
const EMPTY_COUNTS: LearningIterationCounts = {
  sources: 0,
  threads: 0,
  knowledgeFiles: 0,
  memoriesCreated: 0,
  memoriesUpdated: 0,
  memoriesDisabled: 0,
  skillsCreated: 0,
  skillsUpdated: 0,
  rejected: 0
}

type SourceKind = 'thread' | 'memory' | 'knowledge' | 'skill'

type LearningSource = {
  key: string
  kind: SourceKind
  title: string
  fingerprint: string
  content: string
  metadata?: Record<string, unknown>
}

type LearningState = {
  version: 1
  sourceHashes: Record<string, string>
  lastSuccessfulAt: string
  lastCheckedAt: string
  lastLocalDay: string
  lastRetryAt: string
  retryCount: number
  baselineComplete: boolean
  baselineProcessed: number
  baselineRemaining: number
  pendingRunId: string
}

type EvidenceRef = {
  sourceKey: string
  note?: string
}

type MemoryProposal = {
  action: 'create' | 'update' | 'disable'
  id?: string
  content?: string
  scope?: 'user' | 'workspace' | 'project'
  category?: 'profile' | 'preference' | 'workflow' | 'project' | 'interest' | 'matter' | 'other'
  recallPolicy?: 'always' | 'relevant'
  tags?: string[]
  confidence?: number
  explicitCorrection?: boolean
  evidence?: EvidenceRef[]
}

type SkillProposal = {
  action: 'create' | 'update'
  id: string
  name: string
  description: string
  skillMarkdown: string
  tests: Array<{
    prompt: string
    expected: 'should-trigger' | 'should-not-trigger' | 'ambiguous' | 'sibling-confusion'
    reason?: string
    passed?: boolean
  }>
  evidence?: EvidenceRef[]
}

type LearningModelResult = {
  title: string
  summary: string
  reportMarkdown: string
  memories: MemoryProposal[]
  skills: SkillProposal[]
  rejected: Array<{ title: string; reason: string }>
}

type MemorySnapshot = {
  id: string
  content: string
  scope: 'user' | 'workspace' | 'project'
  category?: string
  recallPolicy?: string
  tags?: string[]
  confidence?: number
  origin?: string
  sourceIterationId?: string
  evidence?: EvidenceRef[]
  disabledAt?: string
  deletedAt?: string
  updatedAt?: string
}

type RollbackMemoryOperation = {
  action: 'delete-created' | 'restore'
  id: string
  before?: MemorySnapshot
  afterHash: string
}

type RollbackSkillOperation = {
  action: 'delete-created' | 'restore'
  id: string
  targetPath: string
  backupPath?: string
  afterHash: string
}

type LearningManifest = {
  version: 1
  summary: LearningIterationRecordSummary
  sourceHashes: Record<string, string>
  rollback: {
    memories: RollbackMemoryOperation[]
    skills: RollbackSkillOperation[]
  }
  modelResult?: LearningModelResult
}

type RuntimeDeps = {
  store: JsonSettingsStore
  runtimeRequest: RuntimeRequestFn
  getSystemIdleSeconds: () => number
  getExternalBusy: () => Promise<boolean>
  logError: (category: string, message: string, detail?: unknown) => void
  now?: () => Date
}

type ThreadSummaryJson = {
  id: string
  title?: string
  updatedAt?: string
  status?: string
  relation?: string
}

type KnowledgeNodeJson = {
  name?: string
  path?: string
  kind?: string
  extension?: string
  sizeBytes?: number
  updatedAt?: string
  children?: KnowledgeNodeJson[]
}

class LearningPausedError extends Error {
  constructor() {
    super('检测到新的用户活动，学习迭代已暂停。')
    this.name = 'LearningPausedError'
  }
}

class LearningCancelledError extends Error {
  constructor() {
    super('学习迭代已取消。')
    this.name = 'LearningCancelledError'
  }
}

export class LearningIterationRuntime {
  private timer: ReturnType<typeof setInterval> | null = null
  private queued = false
  private running = false
  private cancelRequested = false
  private manualQueue = false
  private forceRun = false
  private activeRunId = ''
  private activeLearningThreadId = ''
  private message = ''
  private lastPendingSourceCount = 0

  constructor(private readonly deps: RuntimeDeps) {}

  sync(settings: AppSettingsV1): void {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick()
      }, POLL_INTERVAL_MS)
      this.timer.unref?.()
    }
    if (!settings.learningIteration.enabled) {
      this.queued = false
      this.cancelRequested = true
      this.message = '学习迭代已关闭'
      return
    }
    if (!this.running && !this.message) this.message = '正在监听新的交互数据'
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.cancelRequested = true
    this.queued = false
  }

  async status(): Promise<LearningIterationRuntimeStatus> {
    const settings = await this.deps.store.load()
    const state = await this.readState(settings)
    const records = await this.readRecordSummaries(settings)
    const latest = records[0]
    const enabled = settings.learningIteration.enabled
    const eligibleToday = state.lastLocalDay !== localDay(this.now())
    const nextEligibleAt = state.lastSuccessfulAt
      ? eligibleToday
        ? this.now().toISOString()
        : nextLocalDayStart(this.now()).toISOString()
      : ''
    return {
      status: !enabled
        ? 'disabled'
        : this.running
          ? 'running'
          : this.queued
            ? 'waiting'
            : latest?.status === 'failed'
              ? 'failed'
              : latest?.status === 'completed'
                ? 'completed'
                : 'idle',
      enabled,
      eligibleToday,
      queued: this.queued,
      running: this.running,
      message: this.message || (enabled ? '正在监听新的交互数据' : '学习迭代已关闭'),
      lastSuccessfulAt: state.lastSuccessfulAt,
      lastCheckedAt: state.lastCheckedAt,
      nextEligibleAt,
      baselineComplete: state.baselineComplete,
      baselineProgress: state.baselineComplete
        ? 1
        : state.baselineProcessed / Math.max(1, state.baselineProcessed + state.baselineRemaining),
      pendingSourceCount: this.lastPendingSourceCount,
      ...(this.activeRunId ? { activeRunId: this.activeRunId } : {}),
      ...(latest ? { latest } : {})
    }
  }

  async list(): Promise<LearningIterationListResult> {
    try {
      const settings = await this.deps.store.load()
      return { ok: true, records: await this.readRecordSummaries(settings) }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  async get(id: string): Promise<LearningIterationDetailResult> {
    try {
      const settings = await this.deps.store.load()
      const runDir = this.runDir(settings, validateRunId(id))
      const manifest = await this.readManifest(runDir)
      const reportMarkdown = await readFile(join(runDir, 'REPORT.md'), 'utf8')
      return {
        ok: true,
        detail: {
          summary: manifest.summary,
          reportMarkdown
        }
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  async queue(): Promise<LearningIterationActionResult> {
    const settings = await this.deps.store.load()
    if (!settings.learningIteration.enabled) {
      return { ok: false, message: '请先在设置中开启学习迭代。' }
    }
    if (this.running || this.queued) {
      return { ok: true, message: this.running ? '学习迭代正在运行。' : '已在等待空闲时段。' }
    }
    this.queued = true
    this.cancelRequested = false
    this.manualQueue = true
    this.forceRun = true
    this.message = '正在准备学习'
    void this.tick()
    return { ok: true, message: this.message }
  }

  async cancel(): Promise<LearningIterationActionResult> {
    if (!this.running && !this.queued) {
      return { ok: true, message: '当前没有等待或运行中的学习迭代。' }
    }
    this.cancelRequested = true
    this.queued = false
    this.manualQueue = false
    this.message = this.running ? '将在当前阶段结束后停止' : '已取消等待'
    return { ok: true, message: this.message }
  }

  async rollback(id: string): Promise<LearningIterationActionResult> {
    try {
      if (this.running) return { ok: false, message: '学习迭代运行时不能回滚。' }
      const settings = await this.deps.store.load()
      const runDir = this.runDir(settings, validateRunId(id))
      const manifest = await this.readManifest(runDir)
      if (!manifest.summary.canRollback) {
        return { ok: false, message: '该记录不可回滚或已经回滚。' }
      }

      const currentMemories = await this.fetchMemories(settings)
      const memoryById = new Map(currentMemories.map((item) => [item.id, item]))
      for (const operation of manifest.rollback.memories) {
        const current = memoryById.get(operation.id)
        if (!current || hashJson(memoryComparable(current)) !== operation.afterHash) {
          return { ok: false, message: `记忆 ${operation.id} 已在后续发生变化，回滚已停止。` }
        }
      }
      for (const operation of manifest.rollback.skills) {
        if (!existsSync(operation.targetPath) || await hashDirectory(operation.targetPath) !== operation.afterHash) {
          return { ok: false, message: `Skill ${operation.id} 已在后续发生变化，回滚已停止。` }
        }
      }

      for (const operation of [...manifest.rollback.memories].reverse()) {
        if (operation.action === 'delete-created') {
          await this.request(settings, `/v1/memory/${encodeURIComponent(operation.id)}`, 'DELETE')
        } else if (operation.before) {
          await this.request(
            settings,
            `/v1/memory/${encodeURIComponent(operation.id)}`,
            'PATCH',
            JSON.stringify(memoryRestorePatch(operation.before))
          )
        }
      }
      for (const operation of [...manifest.rollback.skills].reverse()) {
        await rm(operation.targetPath, { recursive: true, force: true })
        if (operation.action === 'restore' && operation.backupPath) {
          await cp(operation.backupPath, operation.targetPath, { recursive: true })
        }
      }

      const rolledBackAt = this.now().toISOString()
      manifest.summary = {
        ...manifest.summary,
        status: 'rolled_back',
        canRollback: false,
        rolledBackAt
      }
      await this.writeManifest(runDir, manifest)
      const report = await readFile(join(runDir, 'REPORT.md'), 'utf8')
      await writeFile(
        join(runDir, 'REPORT.md'),
        `${report.trimEnd()}\n\n## 回滚\n\n已于 ${formatDateTime(rolledBackAt)} 完成整轮回滚。\n`,
        'utf8'
      )
      return { ok: true, message: '学习迭代已回滚。', record: manifest.summary }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return
    const settings = await this.deps.store.load()
    if (!settings.learningIteration.enabled) {
      this.forceRun = false
      this.manualQueue = false
      return
    }
    const state = await this.readState(settings)
    const today = localDay(this.now())
    const automaticEligible = state.lastLocalDay !== today
    if (!automaticEligible && !this.forceRun) {
      if (this.queued) {
        this.queued = false
        this.message = '今日已有成功记录，请在下一个自然日再检查'
      }
      return
    }
    if (!this.forceRun && state.lastRetryAt && !retryIsDue(state, this.now())) {
      return
    }
    if (!this.forceRun && await this.isBusy(settings)) {
      if (this.queued) this.message = '正在等待所有任务结束并达到空闲条件'
      return
    }
    this.manualQueue = false

    this.running = true
    this.queued = false
    this.cancelRequested = false
    this.message = '正在采集新增交互数据'
    try {
      await this.run(settings, state)
    } catch (error) {
      if (error instanceof LearningPausedError) {
        await this.writeState(settings, {
          ...state,
          lastCheckedAt: this.now().toISOString(),
          pendingRunId: this.activeRunId || state.pendingRunId
        })
        this.queued = true
        this.message = '检测到新的任务，已暂停并等待下一段空闲时间'
        return
      }
      if (error instanceof LearningCancelledError) {
        await this.writeState(settings, {
          ...state,
          lastCheckedAt: this.now().toISOString(),
          pendingRunId: ''
        })
        this.message = '学习迭代已取消'
        return
      }
      const failedAt = this.now().toISOString()
      const nextState: LearningState = {
        ...state,
        lastCheckedAt: failedAt,
        lastRetryAt: failedAt,
        retryCount: Math.min(2, state.retryCount + 1),
        pendingRunId: ''
      }
      await this.writeState(settings, nextState)
      await this.writeFailureRecord(settings, error).catch((recordError) => {
        this.deps.logError('learning-iteration', 'Failed to write learning failure report', {
          message: errorMessage(recordError)
        })
      })
      this.message = `学习迭代失败：${errorMessage(error)}`
      this.deps.logError('learning-iteration', 'Learning iteration failed', {
        message: errorMessage(error),
        runId: this.activeRunId
      })
    } finally {
      this.running = false
      this.forceRun = false
      this.activeRunId = ''
      this.activeLearningThreadId = ''
    }
  }

  private async run(settings: AppSettingsV1, state: LearningState): Promise<void> {
    const inventory = await this.collectSources(settings, state)
    this.lastPendingSourceCount = inventory.pendingCount
    const checkedAt = this.now().toISOString()
    if (inventory.sources.length === 0) {
      await this.writeState(settings, {
        ...state,
        lastCheckedAt: checkedAt,
        baselineComplete: inventory.pendingCount === 0,
        baselineRemaining: inventory.pendingCount,
        pendingRunId: ''
      })
      this.message = '本周期没有可学习的新数据'
      return
    }
    if (this.cancelRequested) {
      throw new LearningCancelledError()
    }

    const runId = state.pendingRunId || buildRunId(this.now())
    this.activeRunId = runId
    const runDir = this.runDir(settings, runId)
    await mkdir(join(runDir, 'rollback', 'skills'), { recursive: true })
    const startedAt = this.now().toISOString()
    this.message = '正在理解、验证并构造候选记忆与 Skill'
    const corpus = renderCorpus(inventory.sources)
    await writeFile(join(runDir, 'INPUT.md'), corpus, 'utf8')
    await this.writeState(settings, {
      ...state,
      lastCheckedAt: startedAt,
      pendingRunId: runId
    })
    const result = await this.analyzeWithLegalwork(settings, runDir, corpus)
    if (this.cancelRequested) {
      throw new LearningCancelledError()
    }

    this.message = '正在验证并发布学习结果'
    const sourceKeys = new Set(inventory.sources.map((source) => source.key))
    const validated = validateModelResult(
      result,
      sourceKeys,
      new Map(inventory.memories.map((memory) => [memory.id, memory]))
    )
    const protectedSkillCandidates = validated.result.skills.filter((proposal) =>
      inventory.protectedSkillIds.includes(proposal.id)
    )
    if (protectedSkillCandidates.length > 0) {
      validated.result.skills = validated.result.skills.filter((proposal) =>
        !inventory.protectedSkillIds.includes(proposal.id)
      )
      validated.rejectedCount += protectedSkillCandidates.length
      validated.rejectionReasons.push(
        ...protectedSkillCandidates.map((proposal) =>
          `Skill 候选“${proposal.name || proposal.id}”与内置或项目级 Skill 重名，后台不会覆盖。`
        )
      )
    }
    const counts: LearningIterationCounts = {
      ...EMPTY_COUNTS,
      sources: inventory.sources.length,
      threads: inventory.sources.filter((source) => source.kind === 'thread').length,
      knowledgeFiles: inventory.sources.filter((source) => source.kind === 'knowledge').length,
      rejected: result.rejected.length + validated.rejectedCount
    }
    const rollback = await this.applyResult(settings, runDir, validated.result, inventory, counts)
    const finishedAt = this.now().toISOString()
    const title = normalizeTitle(result.title)
    const summary: LearningIterationRecordSummary = {
      id: runId,
      title,
      displayName: `${localDay(this.now())} · ${title}`,
      status: 'completed',
      startedAt,
      finishedAt,
      reportPath: join(runDir, 'REPORT.md'),
      canRollback: rollback.memories.length > 0 || rollback.skills.length > 0,
      counts
    }
    const reportMarkdown = buildReport(validated.result, summary, inventory.sources, validated.rejectionReasons)
    await writeFile(join(runDir, 'REPORT.md'), reportMarkdown, 'utf8')
    const manifest: LearningManifest = {
      version: 1,
      summary,
      sourceHashes: inventory.processedHashes,
      rollback,
      modelResult: validated.result
    }
    await this.writeManifest(runDir, manifest)
    await this.writeState(settings, {
      version: 1,
      sourceHashes: {
        ...state.sourceHashes,
        ...manifest.sourceHashes
      },
      lastSuccessfulAt: finishedAt,
      lastCheckedAt: finishedAt,
      lastLocalDay: localDay(this.now()),
      lastRetryAt: '',
      retryCount: 0,
      baselineComplete: inventory.pendingCount <= inventory.sources.length,
      baselineProcessed: state.baselineProcessed + inventory.sources.length,
      baselineRemaining: Math.max(0, inventory.pendingCount - inventory.sources.length),
      pendingRunId: ''
    })
    this.lastPendingSourceCount = Math.max(0, inventory.pendingCount - inventory.sources.length)
    this.message = '学习迭代已完成并自动应用'
  }

  private async isBusy(settings: AppSettingsV1): Promise<boolean> {
    if (this.deps.getSystemIdleSeconds() < settings.learningIteration.idleMinutes * 60) return true
    if (await this.deps.getExternalBusy()) return true
    const complianceResponse = await this.deps.runtimeRequest(
      settings,
      '/data-compliance/tasks',
      { method: 'GET' }
    )
    if (complianceResponse.ok) {
      const compliance = parseJsonObject(complianceResponse.body)
      const tasks = Array.isArray(compliance?.items)
        ? compliance.items as Array<{ status?: string }>
        : []
      if (tasks.some((task) => task.status === 'pending' || task.status === 'running')) return true
    }
    const response = await this.deps.runtimeRequest(
      settings,
      '/v1/threads?include=side&include_archived=true&limit=500',
      { method: 'GET' }
    )
    if (!response.ok) return true
    const parsed = parseJsonObject(response.body)
    const threads = Array.isArray(parsed?.threads) ? parsed.threads as ThreadSummaryJson[] : []
    return threads.some((thread) =>
      thread.status === 'running' && thread.id !== this.activeLearningThreadId
    )
  }

  private async collectSources(
    settings: AppSettingsV1,
    state: LearningState
  ): Promise<{
    sources: LearningSource[]
    pendingCount: number
    memories: MemorySnapshot[]
    processedHashes: Record<string, string>
    protectedSkillIds: string[]
  }> {
    const candidates: LearningSource[] = []
    const threadResponse = await this.request(
      settings,
      '/v1/threads?include=side&include_archived=true&limit=500',
      'GET'
    )
    const threadObject = parseJsonObject(threadResponse.body)
    const threads = Array.isArray(threadObject?.threads)
      ? (threadObject.threads as ThreadSummaryJson[])
      : []
    const selectedThreads = threads
      .filter((thread) => thread.id && !String(thread.title ?? '').startsWith(LEARNING_THREAD_TITLE_PREFIX))
      .filter((thread) => state.sourceHashes[`thread-meta:${thread.id}`] !== hashJson({
        updatedAt: thread.updatedAt,
        title: thread.title,
        status: thread.status
      }))
      .slice(0, MAX_THREADS)
    let remainingTextAttachments = MAX_THREADS
    for (const thread of selectedThreads) {
      const detail = await this.request(settings, `/v1/threads/${encodeURIComponent(thread.id)}`, 'GET')
      const detailObject = parseJsonObject(detail.body)
      let content = extractThreadText(detailObject)
      const attachmentIds = extractAttachmentIds(detailObject)
        .slice(0, remainingTextAttachments)
      remainingTextAttachments -= attachmentIds.length
      for (const attachmentId of attachmentIds) {
        const metadataResponse = await this.deps.runtimeRequest(
          settings,
          `/v1/attachments/${encodeURIComponent(attachmentId)}`,
          { method: 'GET' }
        )
        if (!metadataResponse.ok) continue
        const metadataObject = parseJsonObject(metadataResponse.body)
        const attachment = metadataObject?.attachment as Record<string, unknown> | undefined
        const name = typeof attachment?.name === 'string' ? attachment.name : attachmentId
        const mimeType = typeof attachment?.mimeType === 'string' ? attachment.mimeType : ''
        const byteSize = typeof attachment?.byteSize === 'number' ? attachment.byteSize : Number.POSITIVE_INFINITY
        if (!isExtractableTextAttachment(name, mimeType) || byteSize > MAX_SINGLE_SOURCE_CHARS) continue
        const contentResponse = await this.deps.runtimeRequest(
          settings,
          `/v1/attachments/${encodeURIComponent(attachmentId)}/content?thread_id=${encodeURIComponent(thread.id)}`,
          { method: 'GET' }
        )
        if (!contentResponse.ok) continue
        const attachmentContent = parseJsonObject(contentResponse.body)
        if (typeof attachmentContent?.dataBase64 !== 'string') continue
        const text = Buffer.from(attachmentContent.dataBase64, 'base64').toString('utf8').trim()
        if (!text || text.includes('\u0000')) continue
        content += `\n\n附件「${name}」可提取文本：\n${text}`
      }
      if (!content.trim()) continue
      addChangedChunks(candidates, state, {
        baseKey: `thread:${thread.id}`,
        kind: 'thread',
        title: thread.title?.trim() || thread.id,
        baseFingerprint: hashJson({
          updatedAt: thread.updatedAt,
          title: thread.title,
          status: thread.status
        }),
        content,
        metadata: {
          id: thread.id,
          updatedAt: thread.updatedAt,
          relation: thread.relation,
          cursorKey: `thread-meta:${thread.id}`,
          cursorFingerprint: hashJson({
            updatedAt: thread.updatedAt,
            title: thread.title,
            status: thread.status
          })
        }
      })
    }

    const memories = await this.fetchMemories(settings)
    let changedDefinitionCount = 0
    for (const memory of memories.filter((item) => !item.deletedAt)) {
      const key = `memory:${memory.id}`
      const fingerprint = hashJson(memoryComparable(memory))
      if (state.sourceHashes[key] === fingerprint) continue
      if (changedDefinitionCount >= MAX_MEMORY_AND_SKILLS) break
      changedDefinitionCount += 1
      candidates.push({
        key,
        kind: 'memory',
        title: memory.content.slice(0, 48),
        fingerprint,
        content: clipSource(JSON.stringify(memory, null, 2)),
        metadata: { id: memory.id, updatedAt: memory.updatedAt }
      })
    }

    const knowledgeResponse = await this.request(settings, '/v1/knowledge/tree', 'GET')
    const knowledgeObject = parseJsonObject(knowledgeResponse.body)
    const knowledgeFiles = flattenKnowledgeNodes(
      Array.isArray(knowledgeObject?.nodes) ? knowledgeObject.nodes as KnowledgeNodeJson[] : []
    )
      .filter((node) => node.path)
      .filter((node) => state.sourceHashes[`knowledge-meta:${node.path}`] !== hashJson({
        updatedAt: node.updatedAt,
        sizeBytes: node.sizeBytes
      }))
      .slice(0, MAX_KNOWLEDGE_FILES)
    for (const file of knowledgeFiles) {
      const path = file.path!
      const endpoint = isPlainTextExtension(file.extension)
        ? `/v1/knowledge/file?path=${encodeURIComponent(path)}`
        : `/v1/knowledge/file/extract-text?path=${encodeURIComponent(path)}`
      const response = await this.deps.runtimeRequest(settings, endpoint, { method: 'GET' })
      if (!response.ok) continue
      const object = parseJsonObject(response.body)
      const content = typeof object?.content === 'string'
        ? object.content
        : typeof object?.text === 'string'
          ? object.text
          : ''
      if (!content.trim()) continue
      addChangedChunks(candidates, state, {
        baseKey: `knowledge:${path}`,
        kind: 'knowledge',
        title: file.name || basename(path),
        baseFingerprint: hashJson({ updatedAt: file.updatedAt, sizeBytes: file.sizeBytes }),
        content,
        metadata: {
          path,
          updatedAt: file.updatedAt,
          extension: file.extension,
          cursorKey: `knowledge-meta:${path}`,
          cursorFingerprint: hashJson({ updatedAt: file.updatedAt, sizeBytes: file.sizeBytes })
        }
      })
    }

    const skillList = await listGuiSkills(settings, settings.workspaceRoot)
    const protectedSkillIds = skillList.ok
      ? [...new Set(skillList.skills
          .filter((skill) => skill.scope === 'builtin' || skill.scope === 'project')
          .map((skill) => skill.id))]
      : []
    if (skillList.ok) {
      for (const skill of skillList.skills) {
        if (changedDefinitionCount >= MAX_MEMORY_AND_SKILLS) break
        const key = `skill:${skill.id}:${skill.root}`
        const read = await readGuiSkillFile(skill.root, skill.entryPath)
        if (!read.ok) continue
        const fingerprint = hashText(read.content)
        if (state.sourceHashes[key] === fingerprint) continue
        changedDefinitionCount += 1
        candidates.push({
          key,
          kind: 'skill',
          title: skill.name,
          fingerprint,
          content: clipSource(read.content),
          metadata: { id: skill.id, scope: skill.scope, root: skill.root }
        })
      }
    }

    const pendingCount = candidates.length
    const sources: LearningSource[] = []
    let totalChars = 0
    for (const source of candidates) {
      const remaining = MAX_SOURCE_CHARS - totalChars
      if (remaining <= 0) break
      if (source.content.length > remaining) break
      if (!source.content.trim()) continue
      sources.push(source)
      totalChars += source.content.length
    }
    const processedHashes: Record<string, string> = Object.fromEntries(
      sources.map((source) => [source.key, source.fingerprint])
    )
    const selectedCountByBase = countSourcesByBase(sources)
    const candidateCountByBase = countSourcesByBase(candidates)
    for (const source of sources) {
      const baseKey = typeof source.metadata?.baseKey === 'string' ? source.metadata.baseKey : source.key
      if (selectedCountByBase.get(baseKey) !== candidateCountByBase.get(baseKey)) continue
      const cursorKey = source.metadata?.cursorKey
      const cursorFingerprint = source.metadata?.cursorFingerprint
      if (typeof cursorKey === 'string' && typeof cursorFingerprint === 'string') {
        processedHashes[cursorKey] = cursorFingerprint
      }
    }
    return { sources, pendingCount, memories, processedHashes, protectedSkillIds }
  }

  private async analyzeWithLegalwork(
    settings: AppSettingsV1,
    runDir: string,
    corpus: string
  ): Promise<LearningModelResult> {
    const runtime = getLegalworkRuntimeSettings(settings)
    const create = await this.request(settings, '/v1/threads', 'POST', JSON.stringify({
      workspace: runDir,
      model: runtime.model,
      mode: 'agent',
      relation: 'side',
      title: `${LEARNING_THREAD_TITLE_PREFIX} ${basename(runDir)}`,
      approvalPolicy: 'never',
      sandboxMode: 'read-only'
    }))
    const thread = parseJsonObject(create.body)
    const threadId = typeof thread?.id === 'string' ? thread.id : ''
    if (!threadId) throw new Error('学习线程创建失败：缺少 thread id。')
    this.activeLearningThreadId = threadId
    const prompt = buildLearningPrompt(corpus)
    const turnResponse = await this.request(
      settings,
      `/v1/threads/${encodeURIComponent(threadId)}/turns`,
      'POST',
      JSON.stringify({
        prompt,
        mode: 'agent',
        model: runtime.model,
        reasoningEffort: 'high',
        approvalPolicy: 'never'
      })
    )
    const turnObject = parseJsonObject(turnResponse.body)
    const turnId = typeof turnObject?.turnId === 'string'
      ? turnObject.turnId
      : typeof (turnObject?.turn as Record<string, unknown> | undefined)?.id === 'string'
        ? String((turnObject!.turn as Record<string, unknown>).id)
        : ''
    if (!turnId) throw new Error('学习线程启动失败：缺少 turn id。')

    const deadline = Date.now() + TURN_TIMEOUT_MS
    let lastText = ''
    while (Date.now() < deadline) {
      if (this.cancelRequested) {
        await this.deps.runtimeRequest(
          settings,
          `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
          { method: 'POST', body: '{}' }
        ).catch(() => undefined)
        throw new LearningCancelledError()
      }
      await sleep(1_500)
      if (await this.isBusy(settings)) {
        // Not idle: poll again without killing the turn. The turn was started
        // intentionally and killing it wastes all tokens spent so far.
        continue
      }
      const detailResponse = await this.request(
        settings,
        `/v1/threads/${encodeURIComponent(threadId)}`,
        'GET'
      )
      const detail = JSON.parse(detailResponse.body) as ThreadDetailJson
      lastText = latestAssistantText(detail, { turnId }) || lastText
      const turn = detail.turns?.find((item) => item.id === turnId)
      if (!turn || turn.status === 'queued' || turn.status === 'running') continue
      if (turn.status !== 'completed') {
        throw new Error(turn.error || `学习线程状态异常：${turn.status}`)
      }
      if (!lastText) throw new Error('学习线程没有返回分析结果。')
      return parseLearningModelResult(lastText)
    }
    throw new Error('学习线程执行超时。')
  }

  private async applyResult(
    settings: AppSettingsV1,
    runDir: string,
    result: LearningModelResult,
    inventory: { memories: MemorySnapshot[] },
    counts: LearningIterationCounts
  ): Promise<LearningManifest['rollback']> {
    const rollback: LearningManifest['rollback'] = { memories: [], skills: [] }
    const memoryById = new Map(inventory.memories.map((item) => [item.id, item]))
    try {
      for (const proposal of result.memories) {
        if (proposal.action === 'create') {
          const response = await this.request(settings, '/v1/memory', 'POST', JSON.stringify({
            content: proposal.content,
            scope: proposal.scope ?? 'user',
            ...((proposal.scope === 'workspace' || proposal.scope === 'project')
              ? { workspace: settings.workspaceRoot }
              : {}),
            ...(proposal.scope === 'project' ? { project: settings.workspaceRoot } : {}),
            category: proposal.category ?? 'preference',
            recallPolicy: proposal.recallPolicy ?? 'relevant',
            captureSource: 'automatic',
            tags: [...new Set([...(proposal.tags ?? []), 'learning-iteration'])],
            confidence: proposal.confidence ?? 0.8,
            origin: 'learning-iteration',
            sourceIterationId: this.activeRunId,
            evidence: proposal.evidence ?? []
          }))
          const object = parseJsonObject(response.body)
          const memory = (object?.memory ?? object) as MemorySnapshot
          if (!memory?.id) throw new Error('创建学习记忆后未返回 id。')
          rollback.memories.push({
            action: 'delete-created',
            id: memory.id,
            afterHash: hashJson(memoryComparable(memory))
          })
          counts.memoriesCreated += 1
          continue
        }
        const id = proposal.id?.trim()
        const before = id ? memoryById.get(id) : undefined
        if (!id || !before) continue
        const patch = proposal.action === 'disable'
          ? { disabled: true }
          : {
              ...(proposal.content ? { content: proposal.content } : {}),
              ...(proposal.scope ? { scope: proposal.scope } : {}),
              ...(proposal.category ? { category: proposal.category } : {}),
              ...(proposal.recallPolicy ? { recallPolicy: proposal.recallPolicy } : {}),
              ...(proposal.tags ? { tags: [...new Set([...proposal.tags, 'learning-iteration'])] } : {}),
              ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {})
            }
        const response = await this.request(
          settings,
          `/v1/memory/${encodeURIComponent(id)}`,
          'PATCH',
          JSON.stringify(patch)
        )
        const object = parseJsonObject(response.body)
        const memory = (object?.memory ?? object) as MemorySnapshot
        rollback.memories.push({
          action: 'restore',
          id,
          before,
          afterHash: hashJson(memoryComparable(memory))
        })
        if (proposal.action === 'disable') counts.memoriesDisabled += 1
        else counts.memoriesUpdated += 1
      }

      for (const proposal of result.skills) {
        const targetPath = join(USER_INSTALLED_SKILL_ROOT, proposal.id)
        const existed = existsSync(targetPath)
        const backupPath = join(runDir, 'rollback', 'skills', proposal.id)
        if (existed) {
          await cp(targetPath, backupPath, { recursive: true })
        }
        await installGeneratedSkill(targetPath, proposal, this.activeRunId)
        rollback.skills.push({
          action: existed ? 'restore' : 'delete-created',
          id: proposal.id,
          targetPath,
          ...(existed ? { backupPath } : {}),
          afterHash: await hashDirectory(targetPath)
        })
        if (existed) counts.skillsUpdated += 1
        else counts.skillsCreated += 1
      }
      return rollback
    } catch (error) {
      await this.rollbackApplied(settings, rollback).catch((rollbackError) => {
        this.deps.logError('learning-iteration', 'Failed to rollback partial publish', {
          message: errorMessage(rollbackError)
        })
      })
      throw error
    }
  }

  private async rollbackApplied(
    settings: AppSettingsV1,
    rollback: LearningManifest['rollback']
  ): Promise<void> {
    for (const operation of [...rollback.memories].reverse()) {
      if (operation.action === 'delete-created') {
        await this.request(settings, `/v1/memory/${encodeURIComponent(operation.id)}`, 'DELETE')
      } else if (operation.before) {
        await this.request(
          settings,
          `/v1/memory/${encodeURIComponent(operation.id)}`,
          'PATCH',
          JSON.stringify(memoryRestorePatch(operation.before))
        )
      }
    }
    for (const operation of [...rollback.skills].reverse()) {
      await rm(operation.targetPath, { recursive: true, force: true })
      if (operation.action === 'restore' && operation.backupPath) {
        await cp(operation.backupPath, operation.targetPath, { recursive: true })
      }
    }
  }

  private async fetchMemories(settings: AppSettingsV1): Promise<MemorySnapshot[]> {
    const response = await this.deps.runtimeRequest(
      settings,
      '/v1/memory?include_deleted=true&limit=500',
      { method: 'GET' }
    )
    if (!response.ok) return []
    const object = parseJsonObject(response.body)
    return Array.isArray(object?.memories) ? object.memories as MemorySnapshot[] : []
  }

  private async request(
    settings: AppSettingsV1,
    path: string,
    method = 'GET',
    body?: string
  ): Promise<{ ok: boolean; status: number; body: string }> {
    const response = await this.deps.runtimeRequest(settings, path, {
      method,
      ...(body !== undefined ? { body } : {})
    })
    if (!response.ok) {
      throw new Error(runtimeErrorMessage(response, `${method} ${path} failed.`))
    }
    return response
  }

  private learningRoot(settings: AppSettingsV1): string {
    return join(resolveLegalworkDataDir(getLegalworkRuntimeSettings(settings)), 'learning-iterations')
  }

  private runDir(settings: AppSettingsV1, id: string): string {
    return join(this.learningRoot(settings), 'runs', id)
  }

  private async readState(settings: AppSettingsV1): Promise<LearningState> {
    try {
      const parsed = JSON.parse(await readFile(join(this.learningRoot(settings), 'state.json'), 'utf8')) as Partial<LearningState>
      return {
        version: 1,
        sourceHashes: parsed.sourceHashes ?? {},
        lastSuccessfulAt: parsed.lastSuccessfulAt ?? '',
        lastCheckedAt: parsed.lastCheckedAt ?? '',
        lastLocalDay: parsed.lastLocalDay ?? '',
        lastRetryAt: parsed.lastRetryAt ?? '',
        retryCount: parsed.retryCount ?? 0,
        baselineComplete: parsed.baselineComplete === true,
        baselineProcessed: parsed.baselineProcessed ?? 0,
        baselineRemaining: parsed.baselineRemaining ?? 0,
        pendingRunId: parsed.pendingRunId ?? ''
      }
    } catch {
      return defaultState()
    }
  }

  private async writeState(settings: AppSettingsV1, state: LearningState): Promise<void> {
    const root = this.learningRoot(settings)
    await mkdir(root, { recursive: true })
    await atomicJsonWrite(join(root, 'state.json'), state)
  }

  private async readRecordSummaries(settings: AppSettingsV1): Promise<LearningIterationRecordSummary[]> {
    const runsRoot = join(this.learningRoot(settings), 'runs')
    const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => [])
    const summaries = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readManifest(join(runsRoot, entry.name))
        .then((manifest) => manifest.summary)
        .catch(() => null)))
    return summaries
      .filter((summary): summary is LearningIterationRecordSummary => Boolean(summary))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  private async readManifest(runDir: string): Promise<LearningManifest> {
    return JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as LearningManifest
  }

  private async writeManifest(runDir: string, manifest: LearningManifest): Promise<void> {
    await mkdir(runDir, { recursive: true })
    await atomicJsonWrite(join(runDir, 'manifest.json'), manifest)
  }

  private async writeFailureRecord(settings: AppSettingsV1, error: unknown): Promise<void> {
    if (!this.activeRunId) return
    const runDir = this.runDir(settings, this.activeRunId)
    const failedAt = this.now().toISOString()
    const summary: LearningIterationRecordSummary = {
      id: this.activeRunId,
      title: '学习迭代失败',
      displayName: `${localDay(this.now())} · 学习迭代失败`,
      status: 'failed',
      startedAt: failedAt,
      finishedAt: failedAt,
      reportPath: join(runDir, 'REPORT.md'),
      canRollback: false,
      counts: { ...EMPTY_COUNTS }
    }
    const message = errorMessage(error)
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'REPORT.md'),
      `# 学习迭代失败\n\n> 本轮没有成功发布，不占用今日额度。\n\n## 错误\n\n${message}\n\n## 后续处理\n\n系统会按退避策略重新检查；不存在部分发布。\n`,
      'utf8'
    )
    await this.writeManifest(runDir, {
      version: 1,
      summary,
      sourceHashes: {},
      rollback: { memories: [], skills: [] }
    })
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }
}

export function createLearningIterationRuntime(deps: RuntimeDeps): LearningIterationRuntime {
  return new LearningIterationRuntime(deps)
}

function defaultState(): LearningState {
  return {
    version: 1,
    sourceHashes: {},
    lastSuccessfulAt: '',
    lastCheckedAt: '',
    lastLocalDay: '',
    lastRetryAt: '',
    retryCount: 0,
    baselineComplete: false,
    baselineProcessed: 0,
    baselineRemaining: 0,
    pendingRunId: ''
  }
}

function retryIsDue(state: LearningState, now: Date): boolean {
  const last = Date.parse(state.lastRetryAt)
  if (!Number.isFinite(last)) return true
  const delay = state.retryCount <= 1 ? 30 * 60_000 : 2 * 60 * 60_000
  return now.getTime() - last >= delay
}

function localDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function nextLocalDayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)
}

function buildRunId(date: Date): string {
  return `${localDay(date)}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}-${randomUUID().slice(0, 8)}`
}

function validateRunId(id: string): string {
  const value = id.trim()
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value)) throw new Error('无效的学习迭代记录 id。')
  return value
}

function normalizeTitle(value: string): string {
  const title = value
    .replace(/^#+\s*/, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 40)
  return title || '学习迭代报告'
}

function renderCorpus(sources: LearningSource[]): string {
  return [
    '# Legalwork 学习迭代输入',
    '',
    '以下内容只用于提取稳定、可复用且可审计的记忆和工作方法。',
    '',
    ...sources.flatMap((source) => [
      `## ${source.kind} · ${source.key} · ${source.title}`,
      '',
      source.content,
      ''
    ])
  ].join('\n')
}

function buildLearningPrompt(corpus: string): string {
  return [
    'Use $legalwork-learning-iteration to analyze the bounded Legalwork interaction corpus below.',
    'Do not call mutation tools and do not write outside the response. Treat client facts as confidential source material, never as reusable skill content.',
    'Only propose automatic memories in profile, preference, workflow, or project. Never propose interest, matter, other, client identity, account identifiers, secrets, passwords, tokens, verification codes, or case facts for automatic storage.',
    'Apply the RIA-TV++-inspired workflow and triple verification. A normal candidate needs evidence from at least two distinct sourceKey values; one source is allowed only for an explicit user correction.',
    'Return exactly one JSON object between the marker lines shown below. Do not use Markdown fences around the JSON.',
    RESULT_BEGIN,
    JSON.stringify({
      title: '10-40 character Chinese report title',
      summary: 'short summary',
      reportMarkdown: '# 学习迭代报告\\n\\n...',
      memories: [{
        action: 'create | update | disable',
        id: 'required for update or disable',
        content: 'required for create/update',
        scope: 'user | workspace | project',
        category: 'profile | preference | workflow | project | interest | matter | other',
        recallPolicy: 'always | relevant',
        tags: ['tag'],
        confidence: 0.8,
        explicitCorrection: false,
        evidence: [{ sourceKey: 'thread:...', note: 'why this supports the candidate' }]
      }],
      skills: [{
        action: 'create | update',
        id: 'lowercase-hyphen-skill-id',
        name: 'Human title',
        description: 'Clear trigger conditions',
        skillMarkdown: 'Complete SKILL.md with only name and description in frontmatter',
        tests: [{
          prompt: 'test prompt',
          expected: 'should-trigger | should-not-trigger | ambiguous | sibling-confusion',
          reason: 'expected behavior',
          passed: true
        }],
        evidence: [{ sourceKey: 'thread:...' }]
      }],
      rejected: [{ title: 'candidate', reason: 'why it failed validation' }]
    }, null, 2),
    RESULT_END,
    '',
    corpus
  ].join('\n')
}

function parseLearningModelResult(text: string): LearningModelResult {
  const start = text.indexOf(RESULT_BEGIN)
  const end = text.indexOf(RESULT_END, start + RESULT_BEGIN.length)
  const jsonText = start >= 0 && end > start
    ? text.slice(start + RESULT_BEGIN.length, end).trim()
    : extractJsonObject(text)
  const parsed = JSON.parse(jsonText) as Partial<LearningModelResult>
  return {
    title: typeof parsed.title === 'string' ? parsed.title : '学习迭代报告',
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    reportMarkdown: typeof parsed.reportMarkdown === 'string' ? parsed.reportMarkdown : '',
    memories: Array.isArray(parsed.memories) ? parsed.memories : [],
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
    rejected: Array.isArray(parsed.rejected) ? parsed.rejected : []
  }
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('学习结果不是有效 JSON。')
  return text.slice(start, end + 1)
}

function validateModelResult(
  result: LearningModelResult,
  sourceKeys: Set<string>,
  memoryById: Map<string, MemorySnapshot>
): {
  result: LearningModelResult
  rejectedCount: number
  rejectionReasons: string[]
} {
  const rejectionReasons: string[] = []
  const memories = result.memories.filter((proposal) => {
    const current = proposal.id ? memoryById.get(proposal.id) : undefined
    const category = proposal.category ?? current?.category ?? (proposal.action === 'create' ? 'preference' : 'other')
    // explicitCorrection bypasses category restriction (e.g. can be 'interest' or 'matter')
    if (!proposal.explicitCorrection && !AUTOMATIC_MEMORY_CATEGORIES.has(category)) {
      rejectionReasons.push(`记忆候选“${proposal.content?.slice(0, 36) || proposal.id || '未命名'}”需要用户确认，不能自动保存。`)
      return false
    }
    if (proposal.action === 'disable' && current?.origin !== 'learning-iteration') {
      rejectionReasons.push(`记忆候选“${proposal.id || '未命名'}”不是自动学习记录，不能由后台学习自动停用。`)
      return false
    }
    const evidence = validEvidence(proposal.evidence, sourceKeys)
    if (evidence.length < 2 && !(proposal.explicitCorrection && evidence.length >= 1)) {
      rejectionReasons.push(`记忆候选“${proposal.content?.slice(0, 36) || proposal.id || '未命名'}”缺少独立证据。`)
      return false
    }
    if (!proposal.explicitCorrection && (proposal.confidence ?? 0) < 0.8) {
      rejectionReasons.push(`记忆候选“${proposal.content?.slice(0, 36) || proposal.id || '未命名'}”置信度低于 0.8。`)
      return false
    }
    if (proposal.content && containsSecret(proposal.content)) {
      rejectionReasons.push('一个记忆候选疑似包含密钥或凭据，已阻止发布。')
      return false
    }
    if (!proposal.explicitCorrection && proposal.content && containsSensitiveIdentifier(proposal.content)) {
      rejectionReasons.push('一个记忆候选可能包含客户、案件或账号标识，需要用户确认，未自动发布。')
      return false
    }
    return proposal.action === 'disable' || Boolean(proposal.content?.trim())
  })
  const skills = result.skills.filter((proposal) => {
    const evidence = validEvidence(proposal.evidence, sourceKeys)
    const categories = new Set(proposal.tests?.map((test) => test.expected) ?? [])
    const valid =
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(proposal.id) &&
      evidence.length >= 2 &&
      proposal.description.trim().length >= 12 &&
      proposal.skillMarkdown.length <= 30_000 &&
      proposal.skillMarkdown.includes('---') &&
      !containsSecret(proposal.skillMarkdown) &&
      proposal.tests.length >= 6 &&
      proposal.tests.length <= 10 &&
      proposal.tests.every((test) => test.passed === true) &&
      categories.has('should-trigger') &&
      categories.has('should-not-trigger') &&
      categories.has('ambiguous') &&
      categories.has('sibling-confusion')
    if (!valid) rejectionReasons.push(`Skill 候选“${proposal.name || proposal.id}”未通过结构或压力测试门槛。`)
    return valid
  })
  return {
    result: { ...result, memories, skills },
    rejectedCount: result.memories.length - memories.length + result.skills.length - skills.length,
    rejectionReasons
  }
}

function validEvidence(evidence: EvidenceRef[] | undefined, sourceKeys: Set<string>): EvidenceRef[] {
  const unique = new Map<string, EvidenceRef>()
  for (const item of evidence ?? []) {
    if (!item || typeof item.sourceKey !== 'string' || !sourceKeys.has(item.sourceKey)) continue
    unique.set(item.sourceKey, item)
  }
  return [...unique.values()]
}

function buildReport(
  result: LearningModelResult,
  summary: LearningIterationRecordSummary,
  sources: LearningSource[],
  rejectionReasons: string[]
): string {
  const sourceRows = sources
    .map((source) => `| ${source.kind} | \`${source.key}\` | ${escapeTable(source.title)} |`)
    .join('\n')
  const memoryRows = result.memories
    .map((memory) => [
      `### ${memory.action} · ${memory.id || memory.content?.slice(0, 48) || '未命名记忆'}`,
      '',
      `- 内容：${memory.content || '（停用现有记忆）'}`,
      `- 证据：${(memory.evidence ?? []).map((item) => `\`${item.sourceKey}\``).join('、') || '无'}`,
      ''
    ].join('\n'))
  const skillRows = result.skills
    .map((skill) => [
      `### ${skill.action} · ${skill.name || skill.id}`,
      '',
      `- 标识：\`${skill.id}\``,
      `- 触发说明：${skill.description}`,
      `- 证据：${(skill.evidence ?? []).map((item) => `\`${item.sourceKey}\``).join('、') || '无'}`,
      '',
      '| 测试类型 | 提示摘要 | 结果 |',
      '|---|---|---|',
      ...skill.tests.map((test) =>
        `| ${test.expected} | ${escapeTable(test.prompt.slice(0, 100))} | ${test.passed ? '通过' : '未通过'} |`
      ),
      ''
    ].join('\n'))
  const audit = [
    `# ${summary.title}`,
    '',
    `> ${result.summary || '本轮已完成增量学习、验证与发布。'}`,
    '',
    '## 执行摘要',
    '',
    `- 记录：${summary.displayName}`,
    `- 时间：${formatDateTime(summary.startedAt)} – ${formatDateTime(summary.finishedAt)}`,
    `- 数据来源：${summary.counts.sources} 项（会话 ${summary.counts.threads}、知识库文件 ${summary.counts.knowledgeFiles}）`,
    `- 记忆变化：新增 ${summary.counts.memoriesCreated}、更新 ${summary.counts.memoriesUpdated}、停用 ${summary.counts.memoriesDisabled}`,
    `- Skill 变化：新增 ${summary.counts.skillsCreated}、更新 ${summary.counts.skillsUpdated}`,
    `- 淘汰候选：${summary.counts.rejected}`,
    '',
    '## 来源范围',
    '',
    '| 类型 | 来源标识 | 标题 |',
    '|---|---|---|',
    sourceRows || '| - | - | - |',
    '',
    '## 记忆变化',
    '',
    ...(memoryRows.length ? memoryRows : ['- 本轮没有通过验证的记忆变化。', '']),
    '## Skill 变化与压力测试',
    '',
    ...(skillRows.length ? skillRows : ['- 本轮没有通过验证的 Skill 变化。', '']),
    '## 验证与发布详情',
    '',
    result.reportMarkdown.trim() || '本轮没有需要补充的模型说明。',
    '',
    '## 自动淘汰',
    '',
    ...(result.rejected.length || rejectionReasons.length
      ? [
          ...result.rejected.map((item) => `- **${item.title}**：${item.reason}`),
          ...rejectionReasons.map((reason) => `- ${reason}`)
        ]
      : ['- 无']),
    '',
    '## 回滚',
    '',
    summary.canRollback
      ? '本轮变更已保存发布前快照，可在学习迭代总览中回滚。'
      : '本轮没有产生需要回滚的记忆或 Skill 变更。',
    ''
  ]
  return audit.join('\n')
}

async function installGeneratedSkill(
  targetPath: string,
  proposal: SkillProposal,
  runId: string
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.learning-${randomUUID()}`
  await mkdir(tempPath, { recursive: true })
  try {
    await writeFile(join(tempPath, 'SKILL.md'), ensureSkillFrontmatter(proposal), 'utf8')
    await writeFile(join(tempPath, 'test-prompts.json'), JSON.stringify(proposal.tests, null, 2), 'utf8')
    await writeFile(join(tempPath, 'learning.json'), JSON.stringify({
      generatedBy: 'legalwork-learning-iteration',
      sourceIterationId: runId,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8')
    await rm(targetPath, { recursive: true, force: true })
    await rename(tempPath, targetPath)
  } finally {
    await rm(tempPath, { recursive: true, force: true }).catch(() => undefined)
  }
}

function ensureSkillFrontmatter(proposal: SkillProposal): string {
  const body = proposal.skillMarkdown.replace(/^---[\s\S]*?---\s*/m, '').trim()
  return [
    '---',
    `name: ${proposal.id}`,
    `description: ${singleLine(proposal.description)}`,
    '---',
    '',
    body || `# ${proposal.name}\n\nFollow the reusable workflow described by the trigger conditions.`,
    ''
  ].join('\n')
}

function memoryRestorePatch(before: MemorySnapshot): Record<string, unknown> {
  return {
    content: before.content,
    scope: before.scope,
    category: before.category ?? 'other',
    recallPolicy: before.recallPolicy ?? 'relevant',
    tags: before.tags ?? [],
    confidence: before.confidence ?? 1,
    disabled: Boolean(before.disabledAt),
    ...(before.deletedAt ? {} : { restore: true })
  }
}

function memoryComparable(memory: MemorySnapshot): Record<string, unknown> {
  return {
    id: memory.id,
    content: memory.content,
    scope: memory.scope,
    category: memory.category,
    recallPolicy: memory.recallPolicy,
    tags: memory.tags ?? [],
    confidence: memory.confidence,
    origin: memory.origin,
    sourceIterationId: memory.sourceIterationId,
    evidence: memory.evidence ?? [],
    disabledAt: memory.disabledAt,
    deletedAt: memory.deletedAt
  }
}

function extractThreadText(object: Record<string, unknown> | null): string {
  const turns = Array.isArray(object?.turns) ? object.turns as Array<Record<string, unknown>> : []
  const lines: string[] = []
  for (const turn of turns) {
    const items = Array.isArray(turn.items) ? turn.items as Array<Record<string, unknown>> : []
    for (const item of items) {
      const kind = String(item.kind ?? '')
      if (kind !== 'user_message' && kind !== 'assistant_text') continue
      const text = typeof item.text === 'string' ? item.text.trim() : ''
      if (!text) continue
      lines.push(`${kind === 'user_message' ? '用户' : 'Legalwork'}：${text}`)
    }
  }
  return lines.join('\n\n')
}

function extractAttachmentIds(object: Record<string, unknown> | null): string[] {
  const turns = Array.isArray(object?.turns) ? object.turns as Array<Record<string, unknown>> : []
  const ids: string[] = []
  for (const turn of turns) {
    if (Array.isArray(turn.attachmentIds)) {
      ids.push(...turn.attachmentIds.filter((id): id is string => typeof id === 'string'))
    }
    const items = Array.isArray(turn.items) ? turn.items as Array<Record<string, unknown>> : []
    for (const item of items) {
      if (!Array.isArray(item.attachmentIds)) continue
      ids.push(...item.attachmentIds.filter((id): id is string => typeof id === 'string'))
    }
  }
  return [...new Set(ids)]
}

function isExtractableTextAttachment(name: string, mimeType: string): boolean {
  if (mimeType.toLowerCase().startsWith('text/')) return true
  if (new Set([
    'application/json',
    'application/ld+json',
    'application/xml',
    'application/javascript',
    'application/x-javascript'
  ]).has(mimeType.toLowerCase())) return true
  return isPlainTextExtension(name.slice(name.lastIndexOf('.')))
}

function flattenKnowledgeNodes(nodes: KnowledgeNodeJson[]): KnowledgeNodeJson[] {
  const out: KnowledgeNodeJson[] = []
  for (const node of nodes) {
    if (node.kind === 'file') out.push(node)
    if (Array.isArray(node.children)) out.push(...flattenKnowledgeNodes(node.children))
  }
  return out
}

function isPlainTextExtension(extension: string | undefined): boolean {
  return new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.html', '.xml'])
    .has((extension ?? '').toLowerCase())
}

function clipSource(content: string): string {
  return redactSecrets(content).slice(0, MAX_SINGLE_SOURCE_CHARS)
}

function addChangedChunks(
  candidates: LearningSource[],
  state: LearningState,
  input: {
    baseKey: string
    kind: SourceKind
    title: string
    baseFingerprint: string
    content: string
    metadata?: Record<string, unknown>
  }
): void {
  const redacted = redactSecrets(input.content)
  const chunkCount = Math.max(1, Math.ceil(redacted.length / MAX_SINGLE_SOURCE_CHARS))
  for (let index = 0; index < chunkCount; index += 1) {
    const content = redacted.slice(
      index * MAX_SINGLE_SOURCE_CHARS,
      (index + 1) * MAX_SINGLE_SOURCE_CHARS
    )
    if (!content.trim()) continue
    const key = chunkCount === 1 ? input.baseKey : `${input.baseKey}#chunk:${index + 1}`
    const fingerprint = hashText(`${input.baseFingerprint}:${hashText(content)}`)
    if (state.sourceHashes[key] === fingerprint) continue
    candidates.push({
      key,
      kind: input.kind,
      title: chunkCount === 1 ? input.title : `${input.title}（${index + 1}/${chunkCount}）`,
      fingerprint,
      content,
      metadata: {
        ...input.metadata,
        baseKey: input.baseKey,
        chunkIndex: index + 1,
        chunkCount
      }
    })
  }
}

function countSourcesByBase(sources: LearningSource[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const source of sources) {
    const baseKey = typeof source.metadata?.baseKey === 'string' ? source.metadata.baseKey : source.key
    counts.set(baseKey, (counts.get(baseKey) ?? 0) + 1)
  }
  return counts
}

function redactSecrets(content: string): string {
  return content
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9]{16,}\b/gi, '[REDACTED TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=\-]{12,}\b/gi, 'Bearer [REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED AWS KEY]')
    .replace(/(?:api[_\s-]?key|token|client[_\s-]?secret|secret|password|passwd|密码|口令|密钥|秘钥|验证码|verification\s*code)\s*(?:[:=：]|是|为)\s*\S+/gi, '[REDACTED CREDENTIAL]')
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().replace(/:/g, ' -')
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value))
}

async function hashDirectory(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true })
  const parts: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      parts.push(`${entry.name}:${await hashDirectory(path)}`)
    } else if (entry.isFile()) {
      parts.push(`${entry.name}:${hashText(await readFile(path, 'utf8').catch(() => ''))}`)
    }
  }
  return hashText(parts.join('\n'))
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await rename(temp, path)
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
