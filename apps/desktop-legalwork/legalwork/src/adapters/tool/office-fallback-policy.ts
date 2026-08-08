import type { ToolHostContext } from '../../ports/tool-host.js'

export const OFFICECLI_TOOL_NAME = 'mcp_officecli_officecli'
export const LEGAL_DOCUMENT_FORMATTING_SKILL_ID = 'legal-document-formatting'
export const OFFICE_FALLBACK_TTL_MS = 60 * 60 * 1000

const grants = new Map<string, number>()

function grantKey(context: Pick<ToolHostContext, 'threadId' | 'turnId'>): string {
  return `${context.threadId}:${context.turnId}`
}

function pruneExpired(now = Date.now()): void {
  for (const [key, grantedAt] of grants) {
    if (now - grantedAt > OFFICE_FALLBACK_TTL_MS) grants.delete(key)
  }
}

/**
 * OfficeCLI is an expensive last-resort executor. A grant is scoped to one
 * turn and expires automatically, so a fallback decision never leaks into a
 * later user request.
 */
export function grantOfficeFallback(
  context: Pick<ToolHostContext, 'threadId' | 'turnId'>,
  now = Date.now()
): void {
  pruneExpired(now)
  grants.set(grantKey(context), now)
}

export function isOfficeFallbackGranted(
  context: Pick<ToolHostContext, 'threadId' | 'turnId'> | undefined,
  now = Date.now()
): boolean {
  if (!context) return false
  pruneExpired(now)
  const grantedAt = grants.get(grantKey(context))
  return grantedAt !== undefined && now - grantedAt <= OFFICE_FALLBACK_TTL_MS
}

export function clearOfficeFallbackGrant(
  context: Pick<ToolHostContext, 'threadId' | 'turnId'>
): void {
  grants.delete(grantKey(context))
}

export function isLegalDocumentFormattingActive(context: ToolHostContext | undefined): boolean {
  return Boolean(
    context?.activeSkillIds?.some((skillId) => skillId === LEGAL_DOCUMENT_FORMATTING_SKILL_ID)
  )
}
