import type { TurnItem } from '../contracts/items.js'
import type { ReviewOutput, ReviewTarget } from '../contracts/review.js'

export type ItemEntity = TurnItem

export function makeUserItem(input: {
  id: string
  turnId: string
  threadId: string
  text: string
  displayText?: string
  attachmentIds?: string[]
}): TurnItem {
  const attachmentIds = input.attachmentIds?.filter((id) => id.trim().length > 0)
  const displayText = input.displayText?.trim()
  return {
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: 'user',
    status: 'completed',
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    kind: 'user_message',
    text: input.text,
    ...(displayText && displayText !== input.text ? { displayText } : {}),
    ...(attachmentIds?.length ? { attachmentIds } : {})
  }
}

export function makeAssistantTextItem(input: {
  id: string
  turnId: string
  threadId: string
  text: string
  status?: 'running' | 'completed' | 'failed'
}): TurnItem {
  return {
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: 'assistant',
    status: input.status ?? 'running',
    createdAt: new Date().toISOString(),
    kind: 'assistant_text',
    text: input.text
  }
}

export function makeAssistantReasoningItem(input: {
  id: string
  turnId: string
  threadId: string
  text: string
  signature?: string
  status?: 'running' | 'completed' | 'failed'
}): TurnItem {
  return {
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: 'assistant',
    status: input.status ?? 'running',
    createdAt: new Date().toISOString(),
    kind: 'assistant_reasoning',
    text: input.text,
    ...(input.signature ? { signature: input.signature } : {})
  }
}

export function makeToolCallItem(input: {
  id: string
  turnId: string
  threadId: string
  callId: string
  toolName: string
  toolKind?: 'tool_call' | 'command_execution' | 'file_change'
  arguments: Record<string, unknown>
  summary?: string
  status?: 'pending' | 'running' | 'completed' | 'failed'
}): TurnItem {
  return {
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: 'tool',
    status: input.status ?? 'pending',
    createdAt: new Date().toISOString(),
    kind: 'tool_call',
    toolName: input.toolName,
    callId: input.callId,
    toolKind: input.toolKind ?? 'tool_call',
    arguments: input.arguments,
    summary: input.summary
  }
}

export function makeToolResultItem(input: {
  id: string
  turnId: string
  threadId: string
  callId: string
  toolName: string
  toolKind?: 'tool_call' | 'command_execution' | 'file_change'
  output: unknown
  isError?: boolean
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'aborted'
  finishedAt?: string
}): TurnItem {
  const status = input.status ?? 'completed'
  return {
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: 'tool',
    status,
    createdAt: new Date().toISOString(),
    ...(input.finishedAt
      ? { finishedAt: input.finishedAt }
      : status === 'completed' || status === 'failed' || status === 'aborted'
        ? { finishedAt: new Date().toISOString() }
        : {}),
    kind: 'tool_result',
    toolName: input.toolName,
    callId: input.callId,
    toolKind: input.toolKind ?? 'tool_call',
    output: input.output,
    isError: input.isError ?? false
  }
}

export function makeApprovalItem(input: {
  id: string
  turnId: string
  threadId: string
  approvalId: string
  toolName: string
  summary: string
}): TurnItem {
  return {
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: 'tool',
    createdAt: new Date().toISOString(),
    kind: 'approval',
    approvalId: input.approvalId,
    toolName: input.toolName,
    summary: input.summary,
    status: 'pending'
  }
}

export function makeUserInputItem(input: {
  id: string
  turnId: string
  threadId: string
  inputId: string
  prompt: string
  questions?: Array<{
    header: string
    id: string
    question: string
    options: Array<{ label: string; description: string }>
  }>
}): TurnItem {
  return {
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: 'tool',
    createdAt: new Date().toISOString(),
    kind: 'user_input',
    inputId: input.inputId,
    prompt: input.prompt,
    questions: input.questions ?? [],
    status: 'pending'
  }
}

export function makeCompactionItem(input: {
  id: string
  turnId: string
  threadId: string
  summary: string
  replacedTokens: number
  pinnedConstraints: string[]
  sourceDigest?: string
  digestMarker?: string
  sourceItemIds?: string[]
}): TurnItem {
  return {
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: 'system',
    status: 'completed',
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    kind: 'compaction',
    summary: input.summary,
    replacedTokens: input.replacedTokens,
    pinnedConstraints: input.pinnedConstraints,
    ...(input.sourceDigest ? { sourceDigest: input.sourceDigest } : {}),
    ...(input.digestMarker ? { digestMarker: input.digestMarker } : {}),
    ...(input.sourceItemIds ? { sourceItemIds: [...input.sourceItemIds] } : {})
  }
}

export function makeReviewItem(input: {
  id: string
  turnId: string
  threadId: string
  target: ReviewTarget
  title: string
  status?: 'running' | 'completed' | 'failed' | 'aborted'
  reviewText?: string
  output?: ReviewOutput
  finishedAt?: string
}): TurnItem {
  const status = input.status ?? 'running'
  return {
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: 'assistant',
    status,
    createdAt: new Date().toISOString(),
    ...(input.finishedAt
      ? { finishedAt: input.finishedAt }
      : status === 'completed' || status === 'failed' || status === 'aborted'
        ? { finishedAt: new Date().toISOString() }
        : {}),
    kind: 'review',
    target: input.target,
    title: input.title,
    ...(input.reviewText ? { reviewText: input.reviewText } : {}),
    ...(input.output ? { output: input.output } : {})
  }
}

export function makeErrorItem(input: {
  id: string
  turnId: string
  threadId: string
  message: string
  code?: string
}): TurnItem {
  return {
    id: input.id,
    turnId: input.turnId,
    threadId: input.threadId,
    role: 'system',
    status: 'failed',
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    kind: 'error',
    message: input.message,
    code: input.code
  }
}

/**
 * Extract the *stable* content of a tool result for provider-bound messages.
 *
 * Tools emit a payload object that carries both meaningful content and
 * volatile metadata (bash: pid/started_at/finished_at/full_output_path).
 * JSON.stringify-ing the whole object puts the volatile fields on the wire, so
 * the same tool result serializes differently across steps (pid/timestamp
 * drift) and defeats the provider's prefix cache.
 *
 * This prefers the stable content field (`.output`, then `.text`, then
 * `.content`) and falls back to the whole payload only when none is present.
 * Existing callers that relied on the full JSON for non-.output tools are
 * unchanged; tools whose content lives in `.output` become cache-stable.
 */
export function stableToolResultText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === null || typeof output !== 'object') return String(output ?? '')
  const record = output as Record<string, unknown>
  for (const key of ['output', 'text', 'content'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return appendStableMetaFields(value, record)
    if (value !== undefined && value !== null && typeof value !== 'string') {
      try {
        return appendStableMetaFields(JSON.stringify(value) ?? '', record)
      } catch {
        return String(value)
      }
    }
  }
  return appendStableMetaFields(JSON.stringify(output) ?? '', record)
}

// 只并入对模型有恢复/判断价值且**非动态**的结构化字段（白名单）：
// bash 的 exit_code / truncation / full_output_path（snake_case，见 builtin-bash-tool 的
// BashOutputPayload）。pid/时间戳等 volatile 字段会导致同结果跨步字节漂移、击穿缓存，一律不并入。
function appendStableMetaFields(text: string, record: Record<string, unknown>): string {
  const meta: string[] = []
  const exitCode = record['exit_code']
  if (typeof exitCode === 'number' && exitCode !== 0) meta.push(`exit_code: ${exitCode}`)
  if (record['truncation'] === true) meta.push('truncated: true')
  const fullPath = record['full_output_path']
  if (typeof fullPath === 'string' && fullPath.trim()) meta.push(`full_output_path: ${fullPath}`)
  return meta.length ? `${text}\n[${meta.join(' ')}]` : text
}

export const DEFAULT_TOOL_RESULT_MAX_TOKENS = 8_000

/**
 * Deterministic token-budget truncation of a tool-result payload for the wire.
 * Head+tail with a marker, mirroring Reasonix's truncateForModelByTokens.
 * Idempotent: the same input always produces the same output, so the confirmed
 * prefix never drifts between model steps. A tool result larger than the budget
 * is capped at roughly `maxTokens` tokens (CJK ≈1 token/char, Latin ≈1 token/4
 * chars — a conservative char-budget approximation, no full tokenize).
 */
export function truncateToolResultContent(content: string, maxTokens = DEFAULT_TOOL_RESULT_MAX_TOKENS): string {
  if (maxTokens <= 0) return ''
  if (content.length <= maxTokens) return content
  // 没有 provider tokenizer 时按 CJK 最坏情况 1 token/字符保守截断。
  // 之前在 content.length 刚超过 maxTokens 时却使用 maxTokens*2 的
  // 字符预算，会同时拼入完整 head 和重复 tail，甚至产生负的 dropped
  // 计数并把 8-16K 字符的结果越截越大。
  const markerOverhead = 160
  const contentBudget = Math.max(0, maxTokens - markerOverhead)
  const tailBudget = Math.min(1024, Math.floor(contentBudget / 2))
  const headBudget = Math.max(0, contentBudget - tailBudget)
  const head = content.slice(0, headBudget)
  const tail = tailBudget > 0 ? content.slice(-tailBudget) : ''
  const dropped = content.length - head.length - tail.length
  const truncated = `${head}\n\n[…truncated ${dropped} chars — 工具结果超过 token 预算，如需完整内容请用更窄的作用域读取（offset/limit/分段）…]\n\n${tail}`
  // Tiny custom budgets can be smaller than the explanatory marker itself.
  // In that case an unmarked hard prefix is still safer than expanding the
  // payload that this function was asked to bound.
  return truncated.length < content.length ? truncated : content.slice(0, maxTokens)
}
