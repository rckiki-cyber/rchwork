import type { ToolHostContext } from '../../ports/tool-host.js'

export const OFFICECLI_TOOL_NAME = 'mcp_officecli_officecli'
export const LEGAL_DOCUMENT_FORMATTING_SKILL_ID = 'legal-document-formatting'
export const OFFICE_FALLBACK_TTL_MS = 60 * 60 * 1000

const grants = new Map<string, number>()
const eligibility = new Map<string, { createdAt: number; reason: string; operation: string }>()

function key(context: Pick<ToolHostContext, 'threadId' | 'turnId'>): string {
  return `${context.threadId}:${context.turnId}`
}

function pruneExpired(now = Date.now()): void {
  for (const [entryKey, grantedAt] of grants) {
    if (now - grantedAt > OFFICE_FALLBACK_TTL_MS) grants.delete(entryKey)
  }
  for (const [entryKey, evidence] of eligibility) {
    if (now - evidence.createdAt > OFFICE_FALLBACK_TTL_MS) eligibility.delete(entryKey)
  }
}

/** Record that the trusted document Skill executor hit a structural limitation. */
export function markOfficeFallbackEligible(
  context: Pick<ToolHostContext, 'threadId' | 'turnId'>,
  evidence: { reason: string; operation: string },
  now = Date.now()
): void {
  pruneExpired(now)
  eligibility.set(key(context), { ...evidence, createdAt: now })
}

/** Consume eligibility once; model-created files/tickets cannot create this state. */
export function consumeOfficeFallbackEligibility(
  context: Pick<ToolHostContext, 'threadId' | 'turnId'>,
  now = Date.now()
): { reason: string; operation: string } | undefined {
  pruneExpired(now)
  const entryKey = key(context)
  const evidence = eligibility.get(entryKey)
  if (!evidence) return undefined
  eligibility.delete(entryKey)
  return { reason: evidence.reason, operation: evidence.operation }
}

/** OfficeCLI is visible only after the runtime explicitly grants this turn. */
export function grantOfficeFallback(
  context: Pick<ToolHostContext, 'threadId' | 'turnId'>,
  now = Date.now()
): void {
  pruneExpired(now)
  grants.set(key(context), now)
}

export function isOfficeFallbackGranted(
  context: Pick<ToolHostContext, 'threadId' | 'turnId'> | undefined,
  now = Date.now()
): boolean {
  if (!context) return false
  pruneExpired(now)
  const grantedAt = grants.get(key(context))
  return grantedAt !== undefined && now - grantedAt <= OFFICE_FALLBACK_TTL_MS
}

export function clearOfficeFallbackGrant(
  context: Pick<ToolHostContext, 'threadId' | 'turnId'>
): void {
  const entryKey = key(context)
  grants.delete(entryKey)
  eligibility.delete(entryKey)
}

export function isLegalDocumentFormattingActive(context: ToolHostContext | undefined): boolean {
  return Boolean(context?.activeSkillIds?.some((skillId) => skillId === LEGAL_DOCUMENT_FORMATTING_SKILL_ID))
}

/** Only genuine document-structure limitations may unlock last-resort Office MCP. */
export function hasStructuralOfficeFallbackEvidence(detail: unknown): boolean {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return false
  const record = detail as Record<string, unknown>
  if (record.tracked_changes === true || record.macros === true) return true
  if (typeof record.spanning_paragraphs === 'number' && record.spanning_paragraphs > 0) return true
  if (Array.isArray(record.keys) && record.keys.length > 0) return true
  return false
}
