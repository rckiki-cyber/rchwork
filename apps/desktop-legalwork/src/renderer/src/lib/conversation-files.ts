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
  'metadata.jsonl',
  'batch_cmds.json'
])
const INTERNAL_PROCESS_NAME_PATTERN =
  /^(?:export_traj|import_traj|fix_font|fix_\w+_font|kg_page(?:-\d+)?|traj_export|extract_\w+|parse_\w+|batch_cmds|batch_commands|scratch|staging|tmp_cmd)\.\w+$/i

function isInternalProcessFile(name: string): boolean {
  const base = name.toLowerCase()
  if (INTERNAL_PROCESS_BASENAMES.has(base)) return true
  return INTERNAL_PROCESS_NAME_PATTERN.test(base)
}

const INTERMEDIATE_NAME_PATTERN =
  /(?:^|[._\-\s])(draft|working|work-in-progress|wip|scratch|staging|temp|tmp|草稿|初稿|中间稿|过程稿|临时稿|过程文件)(?=$|[._\-\s])/i
const HELPER_SCRIPT_NAME_PATTERN =
  /^(?:_?final_draft|export|generate|render|convert|extract|parse|merge|build|fix)[_\-.].*\.(?:py|js|mjs|cjs|ts|sh|bash|zsh|ps1|bat)$/i

/**
 * A heuristic used for tool-event fallback and mixed delivery lists. If the
 * assistant delivers only one of these files it is still allowed, because a
 * requested script or draft can itself be the user's deliverable.
 */
function isLikelyIntermediateFile(name: string): boolean {
  const normalized = name.normalize('NFKC')
  return INTERMEDIATE_NAME_PATTERN.test(normalized) || HELPER_SCRIPT_NAME_PATTERN.test(normalized)
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

type WorkspaceCandidate = {
  path: string
  name: string
}

function workspaceCandidate(rawPath: string, uploadedBasenames: ReadonlySet<string>): WorkspaceCandidate | null {
  const path = normalizedWorkspacePath(rawPath)
  if (!path) return null
  const name = fileNameFromPath(path)
  const base = name.toLowerCase()
  if (uploadedBasenames.has(base) || isInternalProcessFile(name)) return null
  return { path, name }
}

function toolProducedFile(block: Extract<ChatBlock, { kind: 'tool' }>): boolean {
  if (block.status !== 'success' || block.toolKind !== 'file_change' || !block.filePath) return false
  const toolName = typeof block.meta?.toolName === 'string' ? block.meta.toolName.toLowerCase() : ''
  return !['read', 'read_file', 'open_file', 'view_file'].includes(toolName)
}

const VERSION_SUFFIX_PATTERNS = [
  /[（(]\s*(?:v(?:er(?:sion)?)?\s*\d+(?:\.\d+)*|rev(?:ision)?\s*\d+|final(?:[_\-\s]+draft)?|draft|最新版|新版本|新版|最终版|终稿|定稿|修订版|修正版|格式修正版|更新版|正式版|完整版|优化版|草稿|初稿)\s*[)）]$/i,
  /[._\-\s]+(?:v(?:er(?:sion)?)?\s*\d+(?:\.\d+)*|rev(?:ision)?\s*\d+|final(?:[_\-\s]+draft)?|draft|最新版|新版本|新版|最终版|终稿|定稿|修订版|修正版|格式修正版|更新版|正式版|完整版|优化版|草稿|初稿)$/i,
  /[._\-\s]+(?:copy|副本)(?:[._\-\s]*\d+)?$/i,
  /\s*[（(]\d+\s*[)）]$/
] as const

/**
 * Version labels do not create a second logical deliverable. Keep the file
 * extension in the key so a requested DOCX + PDF pair remains two outputs.
 */
function outputFamilyKey(name: string): string {
  const normalized = name.normalize('NFKC').toLowerCase()
  const dotIndex = normalized.lastIndexOf('.')
  const extension = dotIndex > 0 ? normalized.slice(dotIndex + 1) : ''
  let stem = dotIndex > 0 ? normalized.slice(0, dotIndex) : normalized
  let previous = ''
  while (stem && stem !== previous) {
    previous = stem
    for (const pattern of VERSION_SUFFIX_PATTERNS) stem = stem.replace(pattern, '')
    stem = stem.replace(/[._\-\s]+$/, '')
  }
  return `${stem || normalized}::${extension}`
}

function deliveredCandidates(
  assistantCandidates: WorkspaceCandidate[],
  toolCandidates: WorkspaceCandidate[]
): WorkspaceCandidate[] {
  if (assistantCandidates.length > 0) {
    const finalOutputs = assistantCandidates.filter((candidate) => !isLikelyIntermediateFile(candidate.name))
    // If every explicitly delivered file looks draft-like, respect the
    // assistant's delivery: the user may have asked for a script or draft.
    return finalOutputs.length > 0 ? finalOutputs : assistantCandidates
  }
  // Tool events are only a fallback. Process files have not been explicitly
  // delivered to the user, so they never belong in the conversation list.
  return toolCandidates.filter((candidate) => !isLikelyIntermediateFile(candidate.name))
}

export function deriveConversationFiles(blocks: ChatBlock[]): ConversationFile[] {
  const uploadedFiles = new Map<string, ConversationFile>()
  const producedFiles = new Map<string, ConversationFile>()
  // Basenames of user-uploaded attachments. When the agent merely opens or
  // references one of those files (reading it, quoting it), it must not show
  // up a second time as an "Agent 产出" entry.
  const uploadedBasenames = new Set<string>()

  // Collect every user attachment first. An attachment uploaded in a later
  // turn must still win over an earlier agent reference to the same file.
  for (const block of blocks) {
    if (block.kind !== 'user') continue
    for (const attachment of attachmentReferences(block.meta)) {
      const name = attachment.name?.trim() || '未命名附件'
      uploadedFiles.set(`attachment:${attachment.id}`, {
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
  }

  let assistantCandidates: WorkspaceCandidate[] = []
  let toolCandidates: WorkspaceCandidate[] = []

  const flushTurn = (): void => {
    for (const candidate of deliveredCandidates(assistantCandidates, toolCandidates)) {
      const family = outputFamilyKey(candidate.name)
      const key = `workspace:${family}`
      // Delete first so a replacement also moves to its true latest position.
      producedFiles.delete(key)
      producedFiles.set(key, {
        id: key,
        kind: 'workspace',
        path: candidate.path,
        name: candidate.name,
        origin: 'agent'
      })
    }
    assistantCandidates = []
    toolCandidates = []
  }

  for (const block of blocks) {
    if (block.kind === 'user') {
      flushTurn()
      continue
    }
    if (block.kind === 'assistant') {
      for (const rawPath of pathsFromText(block.text)) {
        const candidate = workspaceCandidate(rawPath, uploadedBasenames)
        if (candidate) assistantCandidates.push(candidate)
      }
      continue
    }
    if (block.kind === 'tool' && block.filePath && toolProducedFile(block)) {
      const candidate = workspaceCandidate(block.filePath, uploadedBasenames)
      if (candidate) toolCandidates.push(candidate)
    }
  }
  flushTurn()

  return [...uploadedFiles.values(), ...producedFiles.values()]
}

export function conversationFilesSignature(files: ConversationFile[]): string {
  return files.map((file) => (
    file.kind === 'workspace'
      ? `${file.id}\u0000${file.path}\u0000${file.name}`
      : `${file.id}\u0000${file.name}`
  )).join('\n')
}
