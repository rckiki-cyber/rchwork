import type { AttachmentReference, ChatBlock, RuntimeDisclosureMetadata } from '../agent/types'

export type ConversationFile =
  | {
      id: string
      kind: 'attachment'
      attachmentId: string
      name: string
      mimeType?: string
      origin: 'user'
    }
  | {
      id: string
      kind: 'workspace'
      path: string
      name: string
      origin: 'agent'
    }

// An extension must start with a letter — this rejects date-like tokens
// (2025.03.07, 2026.03.20) whose "extension" is a bare number, while
// still accepting real files (report.pdf, src/foo.ts).
const FILE_NAME_PATTERN = /[^/\\\s<>:"|?*]+\.[a-z][a-z0-9]{0,9}$/i
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(([^)]+)\)/g
const QUOTED_FILE_PATTERN = /(?:^|[\s`'"(])((?:\.{0,2}[/\\]|~[/\\]|[A-Za-z]:[/\\])?[^\s`'"<>|?*()]+\.[a-z][a-z0-9]{0,9})(?=$|[\s`'"),.!?:;])/gi

function fileNameFromPath(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? path
}

/**
 * Internal storage / intermediate artifacts the agent touches while working
 * (its own thread store, trajectory exporters, scratch scripts). These are
 * not meaningful "productions" and would clutter the conversation file list.
 * Only exact well-known names are matched — user files that merely share a
 * prefix (e.g. `traj_数字行政法综述_20260801.jsonl`) are kept.
 */
const INTERNAL_PROCESS_BASENAMES = new Set([
  'events.jsonl',
  'metadata.jsonl'
])
const INTERNAL_PROCESS_NAME_PATTERN =
  /^(?:export_traj|import_traj|fix_font|fix_\w+_font|kg_page(?:-\d+)?|traj_export|extract_\w+|parse_\w+)\.\w+$/i

function isInternalProcessFile(name: string): boolean {
  const base = name.toLowerCase()
  if (INTERNAL_PROCESS_BASENAMES.has(base)) return true
  return INTERNAL_PROCESS_NAME_PATTERN.test(base)
}

// A bare host-like token (beian.cac.gov.cn) looks like a dotted filename
// but is almost always a domain the model mentioned, not a local file.
// Requiring at least one path separator or a leading ~/C:\/../ rejects it
// while keeping workspace-relative and absolute paths.
function isBareHostToken(path: string): boolean {
  if (/[/\\]/.test(path)) return false
  return /^[a-z0-9]+(\.[a-z0-9]+){2,}$/i.test(path)
}

function normalizedWorkspacePath(rawPath: string): string | null {
  const decoded = rawPath.trim().replace(/^<|>$/g, '').replace(/^file:\/\//i, '')
  if (!decoded || /^(?:https?|data|mailto):/i.test(decoded) || decoded.startsWith('#')) return null
  const withoutLocation = decoded.replace(/:(\d+)(?::\d+)?$/, '')
  const name = fileNameFromPath(withoutLocation)
  if (!FILE_NAME_PATTERN.test(name)) return null
  if (isBareHostToken(withoutLocation)) return null
  return withoutLocation
}

function attachmentReferences(meta: RuntimeDisclosureMetadata | undefined): AttachmentReference[] {
  const values = Array.isArray(meta?.attachments) ? meta.attachments : []
  const references = new Map<string, AttachmentReference>()
  for (const value of values) {
    if (!value?.id) continue
    references.set(value.id, value)
  }
  for (const id of meta?.attachmentIds ?? []) {
    if (id && !references.has(id)) references.set(id, { id })
  }
  return [...references.values()]
}

function pathsFromText(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const path = normalizedWorkspacePath(match[1] ?? '')
    if (path) paths.push(path)
  }
  for (const match of text.matchAll(QUOTED_FILE_PATTERN)) {
    const path = normalizedWorkspacePath(match[1] ?? '')
    if (path) paths.push(path)
  }
  return paths
}

export function deriveConversationFiles(blocks: ChatBlock[]): ConversationFile[] {
  const files = new Map<string, ConversationFile>()
  // Basenames of user-uploaded attachments. When the agent merely opens or
  // references one of those files (reading it, quoting it), it must not show
  // up a second time as an "Agent 产出" entry.
  const uploadedBasenames = new Set<string>()

  for (const block of blocks) {
    if (block.kind === 'user') {
      for (const attachment of attachmentReferences(block.meta)) {
        const name = attachment.name?.trim() || '未命名附件'
        files.set(`attachment:${attachment.id}`, {
          id: `attachment:${attachment.id}`,
          kind: 'attachment',
          attachmentId: attachment.id,
          name,
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          origin: 'user'
        })
        const base = fileNameFromPath(name).toLowerCase()
        if (base) uploadedBasenames.add(base)
      }
      continue
    }

    const candidatePaths: string[] = []
    if (block.kind === 'tool' && block.filePath) candidatePaths.push(block.filePath)
    if (block.kind === 'assistant') candidatePaths.push(...pathsFromText(block.text))

    for (const rawPath of candidatePaths) {
      const path = normalizedWorkspacePath(rawPath)
      if (!path) continue
      const fileName = fileNameFromPath(path)
      const base = fileName.toLowerCase()
      // Referencing an already-uploaded file (open/read/quote) is not a
      // separate produced file — skip the duplicate entry.
      if (uploadedBasenames.has(base)) continue
      // Skip internal storage / intermediate artifacts (events.jsonl,
      // metadata.jsonl, exporter scripts, kg_page-*.png, …) — these clutter
      // the conversation file list and are not meaningful productions.
      if (isInternalProcessFile(fileName)) continue
      const key = `workspace:${path.replaceAll('\\', '/')}`
      files.set(key, {
        id: key,
        kind: 'workspace',
        path,
        name: fileName,
        origin: 'agent'
      })
    }
  }

  return [...files.values()]
}

export function conversationFilesSignature(files: ConversationFile[]): string {
  return files.map((file) => file.id).join('\n')
}
