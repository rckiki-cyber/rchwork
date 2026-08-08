/**
 * Document History Service
 *
 * Persists document generation history records to disk.
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { documentHistoryRecordSchema } from '../../shared/document-history'
import type {
  DocumentHistoryRecord,
  DocumentHistorySummary,
  HistoryActionResult
} from '../../shared/document-history'

const HISTORY_DIR_NAME = 'document-history'
const HISTORY_FILE = 'history.json'

let baseDir = ''
let cache: DocumentHistoryRecord[] | null = null
let mutationTail: Promise<void> = Promise.resolve()

export function setHistoryBaseDir(dir: string): void {
  baseDir = join(dir, HISTORY_DIR_NAME)
  cache = null
}

async function ensureDir(): Promise<string> {
  if (!baseDir) throw new Error('History base dir not set.')
  await mkdir(baseDir, { recursive: true })
  return baseDir
}

function filePath(): string {
  return join(baseDir, HISTORY_FILE)
}

async function loadAll(): Promise<DocumentHistoryRecord[]> {
  if (cache) return cache
  await ensureDir()
  try {
    const data = await readFile(filePath(), 'utf-8')
    const parsed = JSON.parse(data) as unknown
    cache = Array.isArray(parsed)
      ? parsed.flatMap((value) => {
          const result = documentHistoryRecordSchema.safeParse(value)
          return result.success ? [result.data] : []
        })
      : []
  } catch {
    cache = []
  }
  return cache!
}

async function persist(records: DocumentHistoryRecord[]): Promise<void> {
  const dir = await ensureDir()
  const target = join(dir, HISTORY_FILE)
  const temporary = join(dir, `${HISTORY_FILE}.${process.pid}.${randomUUID()}.tmp`)
  const snapshot = structuredClone(records)
  try {
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf-8')
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  cache = snapshot
}

function mutateHistory<T>(action: () => Promise<T>): Promise<T> {
  const run = mutationTail.then(action)
  mutationTail = run.then(() => undefined, () => undefined)
  return run
}

/** List all history records (summary only, no content) */
export async function listHistory(): Promise<DocumentHistorySummary[]> {
  const records = await loadAll()
  return records.map((r) => ({
    id: r.id,
    templateName: r.templateName,
    templateCategory: r.templateCategory,
    templateSource: r.templateSource,
    materialCount: r.materialFileNames.length,
    hasInstructions: r.instructions.length > 0,
    createdAt: r.createdAt
  }))
}

/** Get a single full record by id */
export async function getHistoryRecord(
  id: string
): Promise<DocumentHistoryRecord | null> {
  const records = await loadAll()
  const record = records.find((r) => r.id === id)
  return record ? structuredClone(record) : null
}

/** Save a new history record */
export async function saveHistoryRecord(
  record: DocumentHistoryRecord
): Promise<HistoryActionResult> {
  return mutateHistory(async () => {
    try {
      const records = await loadAll()
      // Keep max 500 records, remove oldest
      const updated = [structuredClone(record), ...records].slice(0, 500)
      await persist(updated)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** Delete a history record by id */
export async function deleteHistoryRecord(id: string): Promise<HistoryActionResult> {
  return mutateHistory(async () => {
    try {
      const records = await loadAll()
      const filtered = records.filter((r) => r.id !== id)
      if (filtered.length === records.length) {
        return { ok: false, message: '记录未找到。' }
      }
      await persist(filtered)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** Clear all history */
export async function clearHistory(): Promise<HistoryActionResult> {
  return mutateHistory(async () => {
    try {
      await persist([])
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
}
