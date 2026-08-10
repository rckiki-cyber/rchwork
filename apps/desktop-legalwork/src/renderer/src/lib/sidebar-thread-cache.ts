import type { NormalizedThread } from '../agent/types'
import { browserStorage, type BrowserStorageLike } from './browser-storage'

type SidebarThreadCache = {
  version: 1
  savedAt: string
  threads: NormalizedThread[]
}

const SIDEBAR_THREAD_CACHE_KEY = 'legalwork.sidebarThreads.v1'
export const MAX_CACHED_SIDEBAR_THREADS = 200

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalString(value: unknown): string | undefined {
  const normalized = requiredString(value)
  return normalized || undefined
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function normalizeCachedThread(value: unknown): NormalizedThread | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const id = requiredString(source.id)
  const title = requiredString(source.title)
  const updatedAt = requiredString(source.updatedAt)
  const model = requiredString(source.model)
  const mode = requiredString(source.mode)
  if (!id || !title || !updatedAt || !model || !mode) return null

  const workspace = optionalString(source.workspace)
  const relation = source.relation === 'primary' || source.relation === 'fork' || source.relation === 'side'
    ? source.relation
    : undefined
  const parentThreadId = optionalString(source.parentThreadId)
  const forkedFromThreadId = optionalString(source.forkedFromThreadId)
  const forkedFromTitle = optionalString(source.forkedFromTitle)
  const forkedAt = optionalString(source.forkedAt)
  const forkedFromMessageCount = optionalCount(source.forkedFromMessageCount)
  const forkedFromTurnCount = optionalCount(source.forkedFromTurnCount)

  return {
    id,
    title,
    updatedAt,
    model,
    mode,
    ...(workspace ? { workspace } : {}),
    ...(source.archived === true ? { archived: true } : {}),
    ...(relation ? { relation } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
    ...(forkedFromThreadId ? { forkedFromThreadId } : {}),
    ...(forkedFromTitle ? { forkedFromTitle } : {}),
    ...(forkedAt ? { forkedAt } : {}),
    ...(forkedFromMessageCount !== undefined ? { forkedFromMessageCount } : {}),
    ...(forkedFromTurnCount !== undefined ? { forkedFromTurnCount } : {})
  }
}

export function normalizeSidebarThreadCache(raw: unknown): SidebarThreadCache {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const values = Array.isArray(source.threads) ? source.threads : []
  const threads: NormalizedThread[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const thread = normalizeCachedThread(value)
    if (!thread || seen.has(thread.id)) continue
    seen.add(thread.id)
    threads.push(thread)
    if (threads.length >= MAX_CACHED_SIDEBAR_THREADS) break
  }
  return {
    version: 1,
    savedAt: optionalString(source.savedAt) ?? '',
    threads
  }
}

export function readSidebarThreadCache(
  storage: BrowserStorageLike | null = browserStorage()
): NormalizedThread[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(SIDEBAR_THREAD_CACHE_KEY)
    return normalizeSidebarThreadCache(raw ? JSON.parse(raw) : null).threads
  } catch {
    return []
  }
}

export function saveSidebarThreadCache(
  threads: NormalizedThread[],
  storage: BrowserStorageLike | null = browserStorage()
): void {
  if (!storage) return
  try {
    const cache = normalizeSidebarThreadCache({
      version: 1,
      savedAt: new Date().toISOString(),
      threads
    })
    storage.setItem(SIDEBAR_THREAD_CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* ignore storage failures */
  }
}
