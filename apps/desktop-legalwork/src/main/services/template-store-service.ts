/**
 * Template Store Service
 *
 * Persists user-created templates to disk as a local JSON store.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type {
  TemplateSourceSaveRequest,
  TemplateSourceSaveResult,
  UserTemplate
} from '../../shared/user-templates'

/** Directory where user templates are stored */
export const TEMPLATES_DIR_NAME = 'user-templates'
/** Filename for the templates index */
const TEMPLATES_INDEX_FILE = 'templates.json'
const TEMPLATE_SOURCES_DIR = 'sources'

let templatesDir = ''
let templatesCache: UserTemplate[] | null = null

/** Set the base app data directory (called once at startup) */
export function setTemplatesBaseDir(baseDir: string): void {
  templatesDir = join(baseDir, TEMPLATES_DIR_NAME)
  templatesCache = null
}

/** Ensure the templates directory exists */
async function ensureDir(): Promise<string> {
  if (!templatesDir) {
    throw new Error('Templates base directory not set. Call setTemplatesBaseDir() first.')
  }
  await mkdir(templatesDir, { recursive: true })
  return templatesDir
}

/** Path to the templates index file */
function indexFilePath(): string {
  return join(templatesDir, TEMPLATES_INDEX_FILE)
}

function safeTemplateId(templateId: string): string {
  return templateId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)
}

function sourcesDirectoryPath(): string {
  return join(templatesDir, TEMPLATE_SOURCES_DIR)
}

/** Load all user templates from disk */
export async function loadTemplates(): Promise<UserTemplate[]> {
  if (templatesCache) return templatesCache

  try {
    const filePath = indexFilePath()
    const data = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(data)
    templatesCache = Array.isArray(parsed) ? parsed : []
    return templatesCache!
  } catch {
    // File doesn't exist or is invalid - return empty
    templatesCache = []
    return templatesCache
  }
}

/** Save all user templates to disk */
async function persistTemplates(templates: UserTemplate[]): Promise<void> {
  const dir = await ensureDir()
  const filePath = join(dir, TEMPLATES_INDEX_FILE)
  await writeFile(filePath, JSON.stringify(templates, null, 2), 'utf-8')
  templatesCache = templates
}

/** List all user templates */
export async function listTemplates(): Promise<UserTemplate[]> {
  return loadTemplates()
}

/** Get a single template by id */
export async function getTemplate(id: string): Promise<UserTemplate | null> {
  const templates = await loadTemplates()
  return templates.find((t) => t.id === id) ?? null
}

/** Retain the original DOCX package so exports can patch a copy in place. */
export async function saveTemplateSource(
  request: TemplateSourceSaveRequest
): Promise<TemplateSourceSaveResult> {
  if (extname(request.fileName).toLowerCase() !== '.docx') {
    return { ok: false, message: '只有 DOCX 模板支持保留原文件版式。' }
  }
  try {
    await ensureDir()
    const sourceDir = sourcesDirectoryPath()
    await mkdir(sourceDir, { recursive: true })
    const buffer = Buffer.from(request.dataBase64, 'base64')
    if (buffer.length === 0) {
      return { ok: false, message: '模板文件为空，无法保存原始版式。' }
    }
    const storedFileName = `${safeTemplateId(request.templateId)}.docx`
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    // Atomic write: write to a temp file then rename, so a crash mid-write
    // cannot leave a truncated/corrupt .docx that later fails sha256 verify.
    const finalPath = join(sourceDir, storedFileName)
    const tmpPath = join(sourceDir, `.${storedFileName}.tmp`)
    await writeFile(tmpPath, buffer)
    await rename(tmpPath, finalPath)
    return { ok: true, storedFileName, sha256 }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Resolve and verify a retained template source before format-preserving export. */
export async function readTemplateSource(
  template: UserTemplate
): Promise<Buffer | null> {
  const sourceDocument = template.sourceDocument
  if (!sourceDocument) return null
  const storedFileName = basename(sourceDocument.storedFileName)
  if (storedFileName !== sourceDocument.storedFileName) {
    throw new Error('模板原文件路径无效，请重新上传模板。')
  }
  const buffer = await readFile(join(sourcesDirectoryPath(), storedFileName))
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  if (sha256 !== sourceDocument.sha256) {
    throw new Error('模板原文件校验失败，请重新上传模板。')
  }
  return buffer
}

/** Save a template (create or update) */
export async function saveTemplate(
  template: UserTemplate
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const templates = await loadTemplates()
    const now = new Date().toISOString()
    const existingIdx = templates.findIndex((t) => t.id === template.id)

    if (existingIdx >= 0) {
      // Update existing
      templates[existingIdx] = {
        ...template,
        updatedAt: now
      }
    } else {
      // Create new
      templates.push({
        ...template,
        createdAt: template.createdAt || now,
        updatedAt: now
      })
    }

    await persistTemplates(templates)
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message }
  }
}

/** Delete a template by id */
export async function deleteTemplate(
  id: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const templates = await loadTemplates()
    const filtered = templates.filter((t) => t.id !== id)
    if (filtered.length === templates.length) {
      return { ok: false, message: '模板未找到。' }
    }
    const deleted = templates.find((t) => t.id === id)
    await persistTemplates(filtered)
    if (deleted?.sourceDocument?.storedFileName) {
      const storedFileName = basename(deleted.sourceDocument.storedFileName)
      if (storedFileName === deleted.sourceDocument.storedFileName) {
        await rm(join(sourcesDirectoryPath(), storedFileName), { force: true }).catch(() => undefined)
      }
    }
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message }
  }
}
