import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import type { AttachmentsCapabilityConfig } from '../contracts/capabilities.js'
import type { AttachmentDiagnostics, AttachmentMetadata, AttachmentTextFallback } from '../contracts/attachments.js'
import { AttachmentMetadata as AttachmentMetadataSchema } from '../contracts/attachments.js'

export type AttachmentContent = AttachmentMetadata & {
  data: Buffer
  localFilePath?: string
}

export interface AttachmentStore {
  create(input: {
    name: string
    data: Buffer
    mimeType?: string
    textFallback?: AttachmentTextFallback
    threadId?: string
    workspace?: string
  }): Promise<AttachmentMetadata>
  get(id: string): Promise<AttachmentMetadata | null>
  resolveContent(id: string, scope: { threadId?: string; workspace?: string }): Promise<AttachmentContent>
  textFallbackPolicy(): Pick<
    AttachmentsCapabilityConfig,
    'textFallbackMaxBase64Bytes' | 'textFallbackMaxImageDimension' | 'textFallbackPreferredMimeType'
  >
  diagnostics(): Promise<AttachmentDiagnostics>
}

const ATTACHMENT_ID_RE = /^att_[a-f0-9]{24}$/

function validateAttachmentId(id: string): void {
  if (!ATTACHMENT_ID_RE.test(id)) {
    throw new Error(`invalid attachment id: ${id}`)
  }
}

export class FileAttachmentStore implements AttachmentStore {
  constructor(
    private readonly options: {
      rootDir: string
      config: AttachmentsCapabilityConfig
      nowIso?: () => string
    }
  ) {}

  async create(input: {
    name: string
    data: Buffer
    mimeType?: string
    textFallback?: AttachmentTextFallback
    threadId?: string
    workspace?: string
  }): Promise<AttachmentMetadata> {
    await mkdir(this.options.rootDir, { recursive: true })
    const image = detectImage(input.data)
    const mimeType = image?.mimeType ?? input.mimeType ?? 'application/octet-stream'
    if (image && input.mimeType && input.mimeType !== image.mimeType) {
      throw new Error('declared MIME type does not match image content')
    }
    if (!mimeTypeAllowed(mimeType, this.options.config.allowedMimeTypes)) {
      throw new Error(`attachment MIME type is not allowed: ${mimeType}`)
    }
    if (input.textFallback) validateTextFallback(input.textFallback, this.options.config)
    const hash = createHash('sha256').update(input.data).digest('hex')
    const id = `att_${hash.slice(0, 24)}`
    const contentPath = this.contentPath(id)
    const metadataPath = this.metadataPath(id)
    const now = this.options.nowIso?.() ?? new Date().toISOString()
    const existing = await this.get(id)
    if (existing) {
      const next = mergeScope({
        ...existing,
        ...(input.textFallback ? { textFallback: input.textFallback } : {}),
        updatedAt: now
      }, input)
      await writeFile(contentPath, input.data)
      await this.writeNamedContentFile(next, input.data)
      await writeFile(metadataPath, JSON.stringify(next, null, 2), 'utf8')
      return next
    }
    const metadata: AttachmentMetadata = AttachmentMetadataSchema.parse(mergeScope({
      id,
      name: input.name,
      mimeType,
      byteSize: input.data.byteLength,
      hash,
      ...(image?.width ? { width: image.width } : {}),
      ...(image?.height ? { height: image.height } : {}),
      ...(input.textFallback ? { textFallback: input.textFallback } : {}),
      threadIds: [],
      workspaces: [],
      createdAt: now,
      updatedAt: now
    }, input))
    await writeFile(contentPath, input.data)
    await this.writeNamedContentFile(metadata, input.data)
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8')
    return metadata
  }

  async get(id: string): Promise<AttachmentMetadata | null> {
    try {
      validateAttachmentId(id)
      return AttachmentMetadataSchema.parse(JSON.parse(await readFile(this.metadataPath(id), 'utf8')))
    } catch {
      return null
    }
  }

  async resolveContent(id: string, scope: { threadId?: string; workspace?: string }): Promise<AttachmentContent> {
    validateAttachmentId(id)
    const metadata = await this.get(id)
    if (!metadata) throw new Error(`attachment not found: ${id}`)
    if (!isAuthorized(metadata, scope)) throw new Error(`attachment is not authorized for this turn: ${id}`)
    const data = await readFile(this.contentPath(id))
    return {
      ...metadata,
      data,
      localFilePath: await this.writeNamedContentFile(metadata, data)
    }
  }

  async diagnostics(): Promise<AttachmentDiagnostics> {
    await mkdir(this.options.rootDir, { recursive: true })
    const entries = await readdir(this.options.rootDir).catch(() => [])
    const metadata = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => readFile(join(this.options.rootDir, entry), 'utf8')
          .then((text) => AttachmentMetadataSchema.parse(JSON.parse(text)))
          .catch(() => null))
    )
    const records = metadata.filter((record): record is AttachmentMetadata => Boolean(record))
    return {
      enabled: this.options.config.enabled,
      rootDir: this.options.rootDir,
      count: records.length,
      totalBytes: records.reduce((total, record) => total + record.byteSize, 0)
    }
  }

  textFallbackPolicy(): Pick<
    AttachmentsCapabilityConfig,
    'textFallbackMaxBase64Bytes' | 'textFallbackMaxImageDimension' | 'textFallbackPreferredMimeType'
  > {
    return {
      textFallbackMaxBase64Bytes: this.options.config.textFallbackMaxBase64Bytes,
      textFallbackMaxImageDimension: this.options.config.textFallbackMaxImageDimension,
      textFallbackPreferredMimeType: this.options.config.textFallbackPreferredMimeType
    }
  }

  private contentPath(id: string): string {
    return join(this.options.rootDir, `${id}.bin`)
  }

  private namedContentPath(metadata: Pick<AttachmentMetadata, 'id' | 'name'>): string {
    return join(this.options.rootDir, 'files', metadata.id, safeAttachmentFilename(metadata.name))
  }

  private async writeNamedContentFile(metadata: Pick<AttachmentMetadata, 'id' | 'name'>, data: Buffer): Promise<string> {
    const path = this.namedContentPath(metadata)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
    return path
  }

  private metadataPath(id: string): string {
    return join(this.options.rootDir, `${id}.json`)
  }
}

function safeAttachmentFilename(name: string): string {
  const raw = basename(name.trim() || 'attachment')
  const safe = raw.replace(/[^\w一-龥 .()[\]-]+/g, '_').replace(/^[ ._]+|[ ._]+$/g, '')
  return safe || 'attachment'
}

function mergeScope<T extends AttachmentMetadata>(metadata: T, input: { threadId?: string; workspace?: string }): T {
  return {
    ...metadata,
    threadIds: mergeUnique(metadata.threadIds, input.threadId),
    workspaces: mergeUnique(metadata.workspaces, input.workspace)
  }
}

function mergeUnique(values: string[], value: string | undefined): string[] {
  return value && !values.includes(value) ? [...values, value] : values
}

/** 展开 ~ 并按当前平台规范化，使 "~/Desktop" 与 "/Users/xiangyang/Desktop" 视为同一路径。 */
function normalizeWorkspacePath(path: string): string {
  const expanded = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  return normalize(resolve(expanded))
}

function isAuthorized(metadata: AttachmentMetadata, scope: { threadId?: string; workspace?: string }): boolean {
  if (metadata.threadIds.length === 0 && metadata.workspaces.length === 0) return true
  if (scope.threadId && metadata.threadIds.includes(scope.threadId)) return true
  if (scope.workspace) {
    const scopeWs = normalizeWorkspacePath(scope.workspace)
    return metadata.workspaces.some((ws) => normalizeWorkspacePath(ws) === scopeWs)
  }
  return false
}

function validateTextFallback(fallback: AttachmentTextFallback, config: AttachmentsCapabilityConfig): void {
  if (!mimeTypeAllowed(fallback.mimeType, config.allowedMimeTypes)) {
    throw new Error(`fallback attachment MIME type is not allowed: ${fallback.mimeType}`)
  }
}

function mimeTypeAllowed(mimeType: string, allowedMimeTypes: readonly string[]): boolean {
  return allowedMimeTypes.some((allowed) =>
    allowed === '*/*' ||
    allowed === mimeType ||
    (allowed.endsWith('/*') && mimeType.startsWith(allowed.slice(0, -1)))
  )
}

function detectImage(buffer: Buffer): { mimeType: string; width?: number; height?: number } | null {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mimeType: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg' }
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp' }
  }
  return null
}
