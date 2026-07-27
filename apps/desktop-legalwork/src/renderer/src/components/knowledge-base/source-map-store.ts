/**
 * Module-level store for knowledge base source reference maps.
 *
 * Knowledge chat answers can contain links such as `source://turn-id/1`.
 * Each answer owns an isolated source map, so citations in older messages keep
 * working after the user asks another question. Legacy `source://1` links are
 * resolved against the most recently registered scope for compatibility.
 */

export type KnowledgeSourceMapEntry = {
  path: string
  title: string
  citation?: string
  excerpt?: string
  relevanceScore?: number
}

const DEFAULT_SCOPE = 'current'
const MAX_SCOPES = 80
const sourceMaps = new Map<string, Map<string, KnowledgeSourceMapEntry>>()
let activeScope = DEFAULT_SCOPE
let openFileHandler: ((path: string) => void) | null = null

function trimOldScopes(): void {
  while (sourceMaps.size > MAX_SCOPES) {
    const oldest = sourceMaps.keys().next().value as string | undefined
    if (!oldest) return
    sourceMaps.delete(oldest)
  }
}

function parseSourceRef(ref: string): { scope: string; index: string } {
  const normalized = ref.replace(/^source:\/\//, '').replace(/^\/+|\/+$/g, '')
  const separator = normalized.lastIndexOf('/')
  if (separator > 0) {
    return {
      scope: decodeURIComponent(normalized.slice(0, separator)),
      index: normalized.slice(separator + 1)
    }
  }
  return { scope: activeScope, index: normalized }
}

/** Store the source-to-path mapping for one knowledge-chat answer. */
export function setKnowledgeSourceMap(
  map: Record<number, KnowledgeSourceMapEntry>,
  scope = DEFAULT_SCOPE
): void {
  const normalizedScope = scope.trim() || DEFAULT_SCOPE
  const scopedMap = new Map<string, KnowledgeSourceMapEntry>()
  for (const [key, value] of Object.entries(map)) scopedMap.set(key, value)
  sourceMaps.delete(normalizedScope)
  sourceMaps.set(normalizedScope, scopedMap)
  activeScope = normalizedScope
  trimOldScopes()
}

/** Look up a source ref like `1` or `turn-id/2`. */
export function getKnowledgeSourceEntry(ref: string): KnowledgeSourceMapEntry | undefined {
  const { scope, index } = parseSourceRef(ref)
  return sourceMaps.get(scope)?.get(index)
    ?? sourceMaps.get(activeScope)?.get(index)
    ?? sourceMaps.get(DEFAULT_SCOPE)?.get(index)
}

export function getKnowledgeSourcePath(ref: string): string | undefined {
  return getKnowledgeSourceEntry(ref)?.path
}

/** Register a callback that opens a knowledge base file by its relative path. */
export function setKnowledgeOpenFileHandler(fn: ((path: string) => void) | null): void {
  openFileHandler = fn
}

/** Get the registered file-open handler (called from StreamdownLink). */
export function getKnowledgeOpenFileHandler(): ((path: string) => void) | null {
  return openFileHandler
}
