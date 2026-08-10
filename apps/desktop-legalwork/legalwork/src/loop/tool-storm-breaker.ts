import type { ToolCallLike } from '../ports/tool-host.js'

export type ToolStormBreakerOptions = {
  windowSize?: number
  threshold?: number
  researchLimits?: Partial<Record<ResearchToolCategory, number>>
}

export type ResearchToolCategory = 'discovery' | 'case' | 'law' | 'ima'

type RecentToolCall = {
  name: string
  args: string
  readOnly: boolean
}

const DEFAULT_WINDOW_SIZE = 8
const DEFAULT_THRESHOLD = 3
const MUTATING_TOOL_NAMES = new Set(['write', 'edit', 'edit_diff', 'apply_patch', 'delete', 'move'])
const STORM_EXEMPT_TOOL_NAMES = new Set(['request_user_input', 'user_input'])
const FAILED_DUPLICATE_TOOL_NAMES = new Set(['mcp_officecli_officecli'])
const READ_ONLY_OFFICECLI_VERBS = new Set(['get', 'query', 'view', 'validate', 'help'])
const DEFAULT_RESEARCH_LIMITS: Record<ResearchToolCategory, number> = {
  discovery: 4,
  case: 12,
  law: 8,
  ima: 3
}

/**
 * Prevents repeated identical tool calls from inflating dynamic history
 * and cache misses. It is deliberately turn-scoped; a new user turn is
 * a new intent, so the AgentLoop resets the breaker between turns.
 */
export class ToolStormBreaker {
  private readonly windowSize: number
  private readonly threshold: number
  private readonly researchLimits: Record<ResearchToolCategory, number>
  private readonly recent: RecentToolCall[] = []
  private readonly failedCalls = new Set<string>()
  private readonly activeResearchCalls = new Set<string>()
  private readonly successfulResearchCalls = new Set<string>()
  private readonly failedResearchCalls = new Set<string>()
  private readonly researchCounts = new Map<ResearchToolCategory, number>()
  private lastSuccessfulCallKey = ''

  constructor(options: ToolStormBreakerOptions = {}) {
    this.windowSize = Math.max(1, Math.floor(options.windowSize ?? DEFAULT_WINDOW_SIZE))
    this.threshold = Math.max(2, Math.floor(options.threshold ?? DEFAULT_THRESHOLD))
    this.researchLimits = {
      discovery: normalizedLimit(options.researchLimits?.discovery, DEFAULT_RESEARCH_LIMITS.discovery),
      case: normalizedLimit(options.researchLimits?.case, DEFAULT_RESEARCH_LIMITS.case),
      law: normalizedLimit(options.researchLimits?.law, DEFAULT_RESEARCH_LIMITS.law),
      ima: normalizedLimit(options.researchLimits?.ima, DEFAULT_RESEARCH_LIMITS.ima)
    }
  }

  inspect(call: ToolCallLike): { suppress: boolean; reason?: string } {
    if (STORM_EXEMPT_TOOL_NAMES.has(call.toolName)) return { suppress: false }
    const name = call.toolName
    const args = stableStringify(call.arguments)
    const callKey = toolCallKey(name, args)
    const readOnly = !isMutatingToolCall(call)
    const researchCategory = researchToolCategory(call)

    if (researchCategory) {
      if (this.activeResearchCalls.has(callKey)) {
        return {
          suppress: true,
          reason: `${name} is already running with identical research arguments; wait for and reuse that result.`
        }
      }
      if (this.successfulResearchCalls.has(callKey)) {
        return {
          suppress: true,
          reason: `${name} already completed this exact research query in the current turn; reuse the saved result.`
        }
      }
      if (this.failedResearchCalls.has(callKey)) {
        return {
          suppress: true,
          reason: `${name} already failed with these exact research arguments; change the query or source instead of retrying unchanged.`
        }
      }
      const used = this.researchCounts.get(researchCategory) ?? 0
      const limit = this.researchLimits[researchCategory]
      if (used >= limit) {
        return {
          suppress: true,
          reason:
            `${researchCategory} research reached the per-turn limit of ${limit} distinct calls; ` +
            'synthesize the collected evidence or continue in a new user turn.'
        }
      }
    }

    if (this.lastSuccessfulCallKey === callKey) {
      return {
        suppress: true,
        reason:
          `${name} already completed successfully with identical arguments immediately before this call; ` +
          'repeat-loop guard suppressed the redundant retry. Continue to the next unfinished task stage.'
      }
    }
    // Only consecutive successful duplicates are special. Once the agent
    // performs a different semantic action, an identical later check may be
    // legitimate because that action could have changed the underlying state.
    this.lastSuccessfulCallKey = ''

    if (FAILED_DUPLICATE_TOOL_NAMES.has(name) && this.failedCalls.has(callKey)) {
      return {
        suppress: true,
        reason:
          `${name} already failed with identical arguments in this turn; ` +
          'repeat-loop guard suppressed the unchanged retry. Correct the command shape or retry only the failed batch items.'
      }
    }

    if (!readOnly) {
      this.clearReadOnlyEntries()
    }

    const count = this.recent.reduce(
      (sum, entry) => sum + (entry.name === name && entry.args === args ? 1 : 0),
      0
    )
    if (count >= this.threshold - 1) {
      return {
        suppress: true,
        reason:
          `${name} was called with identical arguments ${count + 1} times in this turn; ` +
          'repeat-loop guard suppressed the duplicate. Choose a narrower query or explain why another identical call is needed.'
      }
    }

    this.recent.push({ name, args, readOnly })
    while (this.recent.length > this.windowSize) this.recent.shift()
    if (researchCategory) {
      this.activeResearchCalls.add(callKey)
      this.researchCounts.set(researchCategory, (this.researchCounts.get(researchCategory) ?? 0) + 1)
    }
    return { suppress: false }
  }

  reset(): void {
    this.recent.length = 0
    this.failedCalls.clear()
    this.activeResearchCalls.clear()
    this.successfulResearchCalls.clear()
    this.failedResearchCalls.clear()
    this.researchCounts.clear()
    this.lastSuccessfulCallKey = ''
  }

  observeResult(call: ToolCallLike, isError: boolean): void {
    const callKey = toolCallKey(call.toolName, stableStringify(call.arguments))
    if (researchToolCategory(call)) {
      this.activeResearchCalls.delete(callKey)
      if (isError) this.failedResearchCalls.add(callKey)
      else this.successfulResearchCalls.add(callKey)
    }
    this.lastSuccessfulCallKey = isError ? '' : callKey
    if (FAILED_DUPLICATE_TOOL_NAMES.has(call.toolName)) {
      if (isError) this.failedCalls.add(callKey)
      else this.failedCalls.delete(callKey)
    }
  }

  private clearReadOnlyEntries(): void {
    for (let index = this.recent.length - 1; index >= 0; index -= 1) {
      if (this.recent[index]?.readOnly) this.recent.splice(index, 1)
    }
  }
}

function normalizedLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value as number)) : fallback
}

function researchToolCategory(call: ToolCallLike): ResearchToolCategory | undefined {
  if (call.toolName === 'mcp_search' || call.toolName === 'mcp_describe') return 'discovery'
  if (call.toolName !== 'mcp_call') return undefined
  const toolId = typeof call.arguments.toolId === 'string'
    ? call.arguments.toolId.toLowerCase()
    : ''
  if (!toolId) return undefined
  if (toolId.includes('ima-knowledge-base/')) return 'ima'
  if (toolId.includes('yuandian-case/') || /pkulaw[^/]*case/.test(toolId)) return 'case'
  if (toolId.includes('yuandian-law/') || /pkulaw[^/]*(?:law|regulation|statute)/.test(toolId)) return 'law'
  return undefined
}

function isMutatingToolCall(call: ToolCallLike): boolean {
  if (call.toolKind === 'file_change') return true
  if (call.toolName === 'mcp_officecli_officecli') {
    const verb = officeCliVerb(call.arguments.command)
    return verb !== '' && !READ_ONLY_OFFICECLI_VERBS.has(verb)
  }
  return MUTATING_TOOL_NAMES.has(call.toolName)
}

function officeCliVerb(command: unknown): string {
  const parts = Array.isArray(command)
    ? command.filter((part): part is string => typeof part === 'string')
    : typeof command === 'string'
      ? command.trim().split(/\s+/)
      : []
  const offset = parts[0]?.toLowerCase() === 'officecli' ? 1 : 0
  return parts[offset]?.toLowerCase() ?? ''
}

function toolCallKey(name: string, args: string): string {
  return `${name}\u0000${args}`
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(canonicalize(value))
  } catch {
    return String(value)
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return out
}
