/**
 * Module-level store for knowledge base source reference maps.
 *
 * When the knowledge base AI chat sends a message, it writes a mapping from
 * [来源 N] → source file path. When the user clicks a rendered
 * [来源 N](#knowledge-source-N)
 * link, StreamdownLink reads the path from here and navigates to the file.
 *
 * Only one mapping is active at a time (the most recent knowledge chat query).
 */

type KnowledgeSourceMapEntry = { path: string; title: string }

const sourceMap = new Map<string, KnowledgeSourceMapEntry>()
let openFileHandler: ((path: string) => void) | null = null

/** Store the source-to-path mapping for the current knowledge chat turn. */
export function setKnowledgeSourceMap(map: Record<number, { path: string; title: string }>): void {
  sourceMap.clear()
  for (const [k, v] of Object.entries(map)) sourceMap.set(k, v)
}

/** Look up a source ref like "1" or "2" → the file path. */
export function getKnowledgeSourcePath(ref: string): string | undefined {
  return sourceMap.get(ref)?.path
}

/** Register a callback that opens a knowledge base file by its relative path. */
export function setKnowledgeOpenFileHandler(fn: ((path: string) => void) | null): void {
  openFileHandler = fn
}

/** Get the registered file-open handler (called from StreamdownLink). */
export function getKnowledgeOpenFileHandler(): ((path: string) => void) | null {
  return openFileHandler
}
