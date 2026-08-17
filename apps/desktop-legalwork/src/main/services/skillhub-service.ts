import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  SkillHubInstallRequest,
  SkillHubInstallResult,
  SkillHubListRequest,
  SkillHubListResult,
  SkillHubSkillSummary
} from '../../shared/ds-gui-api'
import { importGuiSkillFromPath } from './skill-service'

const SKILLHUB_API_ORIGIN = 'https://api.skillhub.cn'
const SKILLHUB_DEFAULT_PAGE_SIZE = 24
const SKILLHUB_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
const SKILLHUB_REQUEST_TIMEOUT_MS = 20_000
const COORDINATE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}$/

type JsonRecord = Record<string, unknown>

const SKILLHUB_CATALOG_QUERIES: Record<SkillHubListRequest['category'], {
  category: string
  keyword?: string
}> = {
  legal: { category: 'professional', keyword: '法律' },
  office: { category: 'office-efficiency' },
  learning: { category: 'knowledge-management' }
}

export async function listSkillHubSkills(request: SkillHubListRequest): Promise<SkillHubListResult> {
  try {
    const page = Math.max(1, Math.trunc(request.page))
    const pageSize = Math.min(48, Math.max(12, Math.trunc(request.pageSize ?? SKILLHUB_DEFAULT_PAGE_SIZE)))
    const catalogQuery = SKILLHUB_CATALOG_QUERIES[request.category]
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sortBy: 'score',
      order: 'desc',
      category: catalogQuery.category
    })
    if (catalogQuery.keyword) params.set('keyword', catalogQuery.keyword)
    const response = await fetchWithTimeout(`${SKILLHUB_API_ORIGIN}/api/skills?${params.toString()}`)
    if (!response.ok) {
      return { ok: false, message: `SkillHub 分类目录请求失败（HTTP ${response.status}）。` }
    }
    const payload = asRecord(await response.json())
    if (finiteNonNegativeNumber(payload.code) !== 0) {
      return { ok: false, message: stringValue(payload.message) || 'SkillHub 分类目录返回错误。' }
    }
    const data = asRecord(payload.data)
    const rawSkills = Array.isArray(data.skills) ? data.skills : []
    const skills = rawSkills
      .map(normalizeSkillHubSkill)
      .filter((skill): skill is SkillHubSkillSummary => skill !== null)
    const total = finiteNonNegativeNumber(data.total)
    return {
      ok: true,
      skills,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize))
    }
  } catch (error) {
    return { ok: false, message: `无法连接 SkillHub：${errorMessage(error)}` }
  }
}

export async function installSkillHubSkill(
  request: SkillHubInstallRequest
): Promise<SkillHubInstallResult> {
  let slug = ''
  let namespace = ''
  try {
    slug = validateCoordinate(request.slug, 'Skill slug')
    namespace = validateCoordinate(request.namespace, 'Skill namespace')
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
  const version = request.version?.trim()
  if (version && !VERSION_PATTERN.test(version)) {
    return { ok: false, message: 'SkillHub 版本号格式无效。' }
  }
  if (!request.targetRoot.trim()) {
    return { ok: false, message: '请选择有效的 Skill 安装目录。' }
  }

  const params = new URLSearchParams({ slug, namespace })
  if (version) params.set('version', version)
  const tempRoot = await mkdtemp(join(tmpdir(), 'legalwork-skillhub-'))
  const archivePath = join(tempRoot, `${slug}.zip`)
  try {
    const response = await fetchWithTimeout(
      `${SKILLHUB_API_ORIGIN}/api/v1/download?${params.toString()}`
    )
    if (!response.ok) {
      return { ok: false, message: `SkillHub 下载失败（HTTP ${response.status}）。` }
    }
    const declaredSize = Number(response.headers.get('content-length') || 0)
    if (declaredSize > SKILLHUB_MAX_ARCHIVE_BYTES) {
      return { ok: false, message: 'SkillHub Skill 压缩包超过 25 MB 安全限制。' }
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > SKILLHUB_MAX_ARCHIVE_BYTES) {
      return { ok: false, message: 'SkillHub Skill 压缩包为空或超过 25 MB 安全限制。' }
    }
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      return { ok: false, message: 'SkillHub 返回的文件不是有效的 zip 压缩包。' }
    }
    await writeFile(archivePath, bytes)
    return await importGuiSkillFromPath(archivePath, request.targetRoot, slug)
  } catch (error) {
    return { ok: false, message: `安装 SkillHub Skill 失败：${errorMessage(error)}` }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function normalizeSkillHubSkill(value: unknown): SkillHubSkillSummary | null {
  const item = asRecord(value)
  const namespace = asRecord(item.namespace)
  const slug = stringValue(item.slug)
  const namespaceHandle = stringValue(namespace.handle)
  if (!COORDINATE_PATTERN.test(slug) || !COORDINATE_PATTERN.test(namespaceHandle)) return null
  const tags = Array.isArray(item.tags)
    ? item.tags.map(stringValue).filter(Boolean).slice(0, 12)
    : []
  return {
    slug,
    name: stringValue(item.name) || slug,
    description: stringValue(item.description_zh) || stringValue(item.description),
    category: stringValue(item.category),
    downloads: finiteNonNegativeNumber(item.downloads),
    installs: finiteNonNegativeNumber(item.installs),
    stars: finiteNonNegativeNumber(item.stars),
    score: finiteNonNegativeNumber(item.score),
    version: stringValue(item.version),
    namespace: namespaceHandle,
    namespaceDisplayName: stringValue(namespace.displayName) || namespaceHandle,
    ...(isHttpsUrl(item.iconUrl) ? { iconUrl: stringValue(item.iconUrl) } : {}),
    tags
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, {
    headers: { Accept: 'application/json, application/zip;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(SKILLHUB_REQUEST_TIMEOUT_MS)
  })
}

function validateCoordinate(value: string, label: string): string {
  const normalized = value.trim()
  if (!COORDINATE_PATTERN.test(normalized)) throw new Error(`${label} 格式无效。`)
  return normalized
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNonNegativeNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
