import type { TurnItem } from '../contracts/items.js'
import type { ImmutablePrefix } from '../cache/immutable-prefix.js'
import { makeCompactionItem } from '../domain/item.js'
import { ContextEstimator } from './context-estimator.js'
import {
  compactedItemsDigestSource,
  computeShortHash,
  createToolDigestMarker
} from './compaction-marker.js'
import {
  DEFAULT_CONTEXT_THRESHOLDS,
  contextThresholdsForModel,
  modelContextProfilesFromConfig,
  type ContextCompactionConfig,
  type ModelConfig,
  type ModelContextProfile,
  type ModelContextThresholds
} from './model-context-profile.js'

export type CompactionMode = 'normal' | 'aggressive' | 'force'

export type CompactionPlan = {
  mode: CompactionMode
  keepRecent: number
  reason: string
}

/**
 * ContextCompactor folds long histories into a single compaction item
 * while preserving pinned user, project, and skill constraints from
 * the immutable prefix. Compaction is triggered by either an explicit
 * `compact()` call or a heuristic on estimated prompt tokens.
 */
export class ContextCompactor {
  private readonly estimator: ContextEstimator
  private readonly softThreshold: number
  private readonly hardThreshold: number
  private readonly modelProfiles: readonly ModelContextProfile[]

  constructor(options?: {
    estimator?: ContextEstimator
    softThreshold?: number
    hardThreshold?: number
    contextCompaction?: ContextCompactionConfig
    models?: ModelConfig
  }) {
    const contextCompaction = options?.contextCompaction
    this.estimator = options?.estimator ?? new ContextEstimator()
    this.softThreshold =
      options?.softThreshold ??
      contextCompaction?.defaultSoftThreshold ??
      DEFAULT_CONTEXT_THRESHOLDS.softThreshold
    this.hardThreshold =
      options?.hardThreshold ??
      contextCompaction?.defaultHardThreshold ??
      DEFAULT_CONTEXT_THRESHOLDS.hardThreshold
    this.modelProfiles = modelContextProfilesFromConfig({
      contextCompaction,
      models: options?.models
    })
  }

  estimate(items: TurnItem[]): number {
    return this.estimator.estimateItems(items)
  }

  shouldCompact(items: TurnItem[], options?: { model?: string; promptTokens?: number; frozenMessageCount?: number }): boolean {
    return this.planCompaction(items, options) !== null
  }

  planCompaction(items: TurnItem[], options?: { model?: string; promptTokens?: number; frozenMessageCount?: number }): CompactionPlan | null {
    const thresholds = this.thresholds(options?.model)
    const frozenMessageCount = normalizeFrozenMessageCount(options?.frozenMessageCount, items.length)
    const compactableItems = frozenMessageCount > 0 ? items.slice(frozenMessageCount) : items
    const estimatedTokens = this.estimate(compactableItems)
    const promptTokens = typeof options?.promptTokens === 'number' ? options.promptTokens : undefined
    const tokens = Math.max(estimatedTokens, promptTokens ?? 0)
    // Message count is not context pressure. Hundreds of short messages can
    // fit comfortably in a long-context model, while one large tool result can
    // exceed a small model's limit. Compact only from estimated/reported token
    // pressure so a model profile's context window remains authoritative.
    if (tokens < thresholds.softThreshold) return null
    const aggressiveThreshold = aggressiveCompactionThreshold(thresholds)
    const mode: CompactionMode =
      tokens >= thresholds.hardThreshold
        ? 'force'
        : tokens >= aggressiveThreshold
          ? 'aggressive'
          : 'normal'
    const source = promptTokens !== undefined && promptTokens >= estimatedTokens ? 'usage prompt_tokens' : 'estimated prompt tokens'
    // A hard overflow must be able to fold the latest item too. Its durable
    // user request and attachment ids are copied into the summary, while the
    // original item remains in the append-only session log for UI/history.
    const keepRecent = mode === 'force' ? 0 : mode === 'aggressive' ? 2 : 4
    return {
      mode,
      keepRecent,
      reason: `${source} ${tokens} reached ${mode} compaction threshold`
    }
  }

  /**
   * Compact the given history in place. Returns a new item list where
   * older items are replaced by a single `compaction` summary item.
   * The summary always lists the pinned constraints so they survive
   * even when the original text is removed.
   */
  compact(input: {
    threadId: string
    turnId: string
    history: TurnItem[]
    prefix: ImmutablePrefix
    budgetTokens?: number
    keepRecent?: number
    mode?: CompactionMode
    reason?: string
    summaryOverride?: string
    frozenMessageCount?: number
  }): {
    next: TurnItem[]
    summaryItem: TurnItem
    replacedTokens: number
  } {
    const frozenMessageCount = normalizeFrozenMessageCount(
      input.frozenMessageCount,
      input.history.length
    )
    const frozen = frozenMessageCount > 0 ? input.history.slice(0, frozenMessageCount) : []
    const history = trimTrailingToolCalls(input.history.slice(frozenMessageCount))
    const requestedKeepRecent = Math.max(0, input.keepRecent ?? 4)
    const keepRecent = requestedKeepRecent === 0
      ? 0
      : history.length <= 1
        ? history.length
        : Math.min(requestedKeepRecent, history.length - 1)
    if (history.length === 0 || history.length - keepRecent <= 0) {
      return {
        next: [...frozen, ...history],
        summaryItem: makeCompactionItem({
          id: `compaction_${input.turnId}_noop`,
          turnId: input.turnId,
          threadId: input.threadId,
          summary: 'no compaction needed',
          replacedTokens: 0,
          pinnedConstraints: input.prefix.pinnedConstraints
        }),
        replacedTokens: 0
      }
    }
    const head = keepRecent === 0 ? history : history.slice(0, history.length - keepRecent)
    const tail = keepRecent === 0 ? [] : history.slice(-keepRecent)
    const replacedTokens = this.estimator.estimateItems(head)
    const sourceDigest = computeShortHash(compactedItemsDigestSource(head))
    const digestMarker = createToolDigestMarker(sourceDigest)
    const summaryBase = input.summaryOverride?.trim() || buildCompactionSummary({
      history,
      head,
      tail,
      prefix: input.prefix,
      reason: input.reason,
      mode: input.mode,
      budgetTokens: input.budgetTokens
    })
    const summary = appendDigestMarker(summaryBase, digestMarker)
    const summaryItem = makeCompactionItem({
      id: `compaction_${input.turnId}_${Date.now()}`,
      turnId: input.turnId,
      threadId: input.threadId,
      summary,
      replacedTokens,
      pinnedConstraints: input.prefix.pinnedConstraints,
      sourceDigest,
      digestMarker,
      sourceItemIds: head.map((item) => item.id)
    })
    return { next: [...frozen, summaryItem, ...tail], summaryItem, replacedTokens }
  }

  /** Hard cap used by the loop to enforce an upper bound on the conversation. */
  hardCap(model?: string): number {
    return this.thresholds(model).hardThreshold
  }

  thresholds(model?: string): ModelContextThresholds {
    return contextThresholdsForModel(model, {
      softThreshold: this.softThreshold,
      hardThreshold: this.hardThreshold
    }, this.modelProfiles)
  }
}

export function trimTrailingToolCalls(history: TurnItem[]): TurnItem[] {
  let end = history.length
  while (end > 0) {
    const item = history[end - 1]
    if (item.kind !== 'tool_call') break
    end -= 1
  }
  return end === history.length ? history : history.slice(0, end)
}

function aggressiveCompactionThreshold(thresholds: ModelContextThresholds): number {
  const span = Math.max(0, thresholds.hardThreshold - thresholds.softThreshold)
  return thresholds.softThreshold + Math.floor(span * 0.6)
}

function normalizeFrozenMessageCount(value: number | undefined, historyLength: number): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(historyLength, Math.floor(value)))
}

function appendDigestMarker(summary: string, digestMarker: string): string {
  const trimmed = summary.trim()
  if (trimmed.includes(digestMarker)) return trimmed
  return `${trimmed}\n\nCompaction digest marker: ${digestMarker}`
}

function buildCompactionSummary(input: {
  history: TurnItem[]
  head: TurnItem[]
  tail: TurnItem[]
  prefix: ImmutablePrefix
  reason?: string
  mode?: CompactionMode
  budgetTokens?: number
}): string {
  const contentBudget = summaryCharBudget(input.budgetTokens)
  const lines: string[] = []
  if (input.reason) {
    lines.push(`Reason: ${input.reason}`)
  }
  if (input.mode) {
    lines.push(`Mode: ${input.mode}`)
  }
  if (input.budgetTokens !== undefined) {
    lines.push(`Budget: ${input.budgetTokens} tokens`)
  }
  lines.push('Pinned constraints (preserved across compaction):')
  if (input.prefix.pinnedConstraints.length === 0) {
    lines.push('- (none)')
  } else {
    for (const pinned of input.prefix.pinnedConstraints) {
      lines.push(`- ${pinned}`)
    }
  }
  const skillPins = extractSkillPins(input.history)
  if (skillPins.length > 0) {
    lines.push('Pinned skills (preserved across compaction):')
    for (const skillPin of skillPins) {
      lines.push(`- ${skillPin}`)
    }
    lines.push('')
  }
  const durableUserRequests = input.head
    .filter((item): item is Extract<TurnItem, { kind: 'user_message' }> => item.kind === 'user_message')
    .filter((item) => item.text.trim() || (item.attachmentIds?.length ?? 0) > 0)
    .reverse()
  if (durableUserRequests.length > 0) {
    lines.push('Durable user requests (newest first; preserve as authoritative):')
    for (const item of fitDurableUserRequests(durableUserRequests, Math.max(12_000, contentBudget))) {
      const attachmentNote = item.attachmentIds?.length
        ? ` [uploaded files: ${item.attachmentIds.join(', ')}]`
        : ''
      lines.push(`- ${clipText(item.text, 6_000)}${attachmentNote}`)
    }
    lines.push('')
  }
  const attachmentIds = [...new Set(
    input.history.flatMap((item) => item.kind === 'user_message' ? item.attachmentIds ?? [] : [])
  )]
  if (attachmentIds.length > 0) {
    lines.push('Uploaded file registry (never discard; file bytes remain in the attachment store):')
    for (const attachmentId of attachmentIds) lines.push(`- ${attachmentId}`)
    lines.push('')
  }
  const inheritedSummaries = input.head.filter(
    (item): item is Extract<TurnItem, { kind: 'compaction' }> =>
      item.kind === 'compaction' && item.replacedTokens > 0 && item.summary.trim().length > 0
  )
  if (inheritedSummaries.length > 0) {
    lines.push('Inherited durable context from earlier compactions (preserve transitively):')
    for (const item of inheritedSummaries) {
      lines.push(clipText(item.summary, Math.max(8_000, Math.floor(contentBudget / inheritedSummaries.length))))
    }
    lines.push('')
  }
  lines.push('')
  lines.push(
    `Summarized ${input.history.length} item(s); ${input.tail.length} recent item(s) are also kept verbatim for the current request.`
  )
  lines.push('Conversation and work summary:')
  const summaryLines = fitLinesToBudget(
    selectSummaryLines(input.history),
    contentBudget
  )
  if (summaryLines.length === 0) {
    lines.push('- No user-visible content before compaction.')
  } else {
    lines.push(...summaryLines)
  }
  return lines.join('\n')
}

function fitDurableUserRequests(
  items: Array<Extract<TurnItem, { kind: 'user_message' }>>,
  charBudget: number
): Array<Extract<TurnItem, { kind: 'user_message' }>> {
  const selected: Array<Extract<TurnItem, { kind: 'user_message' }>> = []
  let used = 0
  for (const item of items) {
    const cost = Math.min(item.text.length, 6_000) + (item.attachmentIds?.join(', ').length ?? 0) + 32
    if (selected.length > 0 && used + cost > charBudget) continue
    selected.push(item)
    used += cost
  }
  return selected
}

function extractSkillPins(history: TurnItem[]): string[] {
  const pins = new Set<string>()
  for (const item of history) {
    if (item.kind !== 'assistant_text' && item.kind !== 'user_message' && item.kind !== 'compaction') continue
    const text = item.kind === 'compaction' ? item.summary : item.text
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (/^(Active Skill:|Skill Pin:|Pinned Skill:)/i.test(trimmed)) {
        pins.add(clipText(trimmed, 600))
      }
    }
  }
  return [...pins]
}

function summaryCharBudget(budgetTokens: number | undefined): number {
  if (budgetTokens === undefined) return 32_000
  return Math.max(8_000, Math.min(64_000, budgetTokens * 4))
}

function summarizeItem(item: TurnItem): string {
  switch (item.kind) {
    case 'user_message':
      return `- User: ${clipText(item.text)}`
    case 'assistant_text':
      return `- Assistant: ${clipText(item.text)}`
    case 'assistant_reasoning':
      return ''
    case 'tool_call':
      return `- Tool call ${item.toolName}: ${clipText(item.summary || stringifyCompact(item.arguments))}`
    case 'tool_result':
      return `- Tool result ${item.toolName}${item.isError ? ' error' : ''}: ${clipText(stringifyCompact(item.output))}`
    case 'approval':
      return `- Approval ${item.status} for ${item.toolName}: ${clipText(item.summary)}`
    case 'user_input':
      return `- User input ${item.status}: ${clipText(item.prompt)}`
    case 'compaction':
      return item.replacedTokens > 0
        ? `- Earlier compaction summary: ${clipText(item.summary, 600)}`
        : ''
    case 'review':
      return `- Review ${item.title}: ${clipText(item.reviewText || stringifyCompact(item.output))}`
    case 'error':
      return `- Error${item.code ? ` ${item.code}` : ''}: ${clipText(item.message)}`
  }
}

function selectSummaryLines(items: TurnItem[]): string[] {
  const summarized = items.map(summarizeItem)
  const populated = summarized.filter((line) => line.length > 0)
  if (populated.length <= 80) return populated
  const selectedIndexes = new Set<number>()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (
      item?.kind === 'user_message' || item?.kind === 'error' ||
      item?.kind === 'approval' || item?.kind === 'user_input' ||
      item?.kind === 'review' || item?.kind === 'compaction'
    ) {
      selectedIndexes.add(index)
    }
  }
  for (let index = 0; index < Math.min(12, items.length); index += 1) selectedIndexes.add(index)
  for (let index = Math.max(0, items.length - 56); index < items.length; index += 1) {
    selectedIndexes.add(index)
  }
  const selected = [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => summarized[index] ?? '')
    .filter((line) => line.length > 0)
  return [
    ...selected,
    `- ${Math.max(0, populated.length - selected.length)} low-priority middle item(s) omitted from this compact summary; all user requests and errors were retained above.`
  ]
}

function fitLinesToBudget(lines: string[], budget: number): string[] {
  const out: string[] = []
  let used = 0
  for (const line of lines) {
    const nextCost = line.length + 1
    if (used + nextCost <= budget) {
      out.push(line)
      used += nextCost
      continue
    }
    const remaining = budget - used
    if (remaining > 80) out.push(clipText(line, remaining))
    break
  }
  return out
}

function stringifyCompact(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function clipText(text: string, max = 360): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 3)).trim()}...`
}
