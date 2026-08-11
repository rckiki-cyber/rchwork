import type { ToolCallLike } from '../ports/tool-host.js'

export type ToolCallArgumentRepairOptions = {
  toolName?: string
  toolKind?: ToolCallLike['toolKind']
  maxStringBytes?: number
}

export type ToolCallArgumentRepairResult = {
  arguments: Record<string, unknown>
  notes: string[]
}

const DEFAULT_MAX_STRING_BYTES = 512 * 1024
const WRAPPER_KEYS = ['arguments', 'args', 'input', 'parameters', 'params', 'payload', '__raw']
const TOOL_METADATA_KEYS = new Set([
  'tool',
  'toolName',
  'tool_name',
  'name',
  'id',
  'callId',
  'call_id',
  'type'
])
/**
 * bash 无效调用的占位命令。命令会被 shell 以 `-lc` 执行，因此必须是纯常量、
 * 不能拼接任何模型参数（否则构成命令注入）。模型在超长上下文中会偶尔发出
 * command 缺失或为 `{}`/空串的退化调用，这里用一条可执行的报错命令把问题
 * 显式暴露给模型，并给出可执行的纠正指引，避免模型反复重发同一坏形状。
 */
const BASH_INVALID_COMMAND_STUB =
  `echo 'Invalid bash call: command argument was missing or empty; resend with the actual command text' >&2; exit 1`

/**
 * Provider-neutral repair pass for already-parsed tool arguments.
 *
 * Model adapters repair JSON strings while parsing provider payloads; this
 * boundary pass catches provider-agnostic shapes that can still reach the
 * loop as Records, such as `{ arguments: "{\"path\":\"a.ts\"}" }`.
 */
export function repairDispatchToolArguments(
  raw: Record<string, unknown>,
  options: ToolCallArgumentRepairOptions = {}
): ToolCallArgumentRepairResult {
  const notes: string[] = []
  let current = shallowCloneRecord(raw)

  const flattened = flattenWrapper(current)
  if (flattened) {
    current = flattened.arguments
    notes.push(flattened.note)
  } else {
    // bash 的 command 是 shell 命令文本，不是参数 JSON 载体：即使它恰好是
    // `{}`、空串、或正文里包含 JSON 片段（如 python3 -c 'print({"a":1})'），
    // 也不能把它当 JSON 参数解析，否则会摧毁真实命令。
    const scavenged = scavengeSingleJsonString(
      current,
      options.toolName === 'bash' ? 'command' : undefined
    )
    if (scavenged) {
      current = scavenged.arguments
      notes.push(scavenged.note)
    }
  }

  const truncated = truncateOversizedStrings(current, {
    maxStringBytes: options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES,
    preserveLongStrings: options.toolKind === 'file_change'
  })
  if (truncated.changed) {
    current = truncated.value
    notes.push(`truncated ${truncated.count} oversized argument string(s)`)
  }

  if (options.toolName === 'bash') {
    const repairedBash = repairBashCommandArgument(current)
    if (repairedBash.changed) {
      current = repairedBash.arguments
      notes.push(repairedBash.note)
    }
  }

  return { arguments: current, notes }
}

/**
 * bash 命令参数校验与修复：
 * - command 缺失 → 用常量占位命令，note 保留原参数摘要供排查；
 * - command 是空串 / `{}` / 纯空白 → 同上（模型实际发过 command:"{}" 的退化调用）；
 * - command 是对象（provider 包裹形态，如 {command:{command:'ls'}}）→ 提取内层命令；
 * - command 是正常非空字符串 → 原样保留，绝不改动。
 */
function repairBashCommandArgument(current: Record<string, unknown>): {
  arguments: Record<string, unknown>
  changed: boolean
  note: string
} {
  // Session-control actions deliberately do not carry a command. Requiring
  // one here rewrites a valid `{ action: "poll", session_id: "..." }` call
  // into the invalid-command stub before it reaches builtin-bash-tool, which
  // strands the live process and sends the model into a retry loop.
  const action = typeof current.action === 'string' ? current.action.trim().toLowerCase() : ''
  if (action === 'poll' || action === 'write' || action === 'stop') {
    return { arguments: current, changed: false, note: '' }
  }
  const commandValue = current.command
  if (typeof commandValue === 'string') {
    const trimmed = commandValue.trim()
    if (trimmed === '' || trimmed === '{}' || trimmed === '{ }' || trimmed === '{\n}') {
      return {
        arguments: { ...current, command: BASH_INVALID_COMMAND_STUB },
        changed: true,
        note:
          `repaired invalid bash call with empty command ` +
          `(command=${JSON.stringify(commandValue.slice(0, 200))})`
      }
    }
    return { arguments: current, changed: false, note: '' }
  }
  if (commandValue === undefined) {
    const argSummary = safeStringifySlice(current, 200)
    return {
      arguments: { ...current, command: BASH_INVALID_COMMAND_STUB },
      changed: true,
      note: `repaired invalid bash call missing "command" (args=${argSummary})`
    }
  }
  if (commandValue !== null && typeof commandValue === 'object') {
    const wrapped = commandValue as Record<string, unknown>
    const innerCommand = wrapped.command ?? wrapped.cmd ?? wrapped.text
    if (typeof innerCommand === 'string' && innerCommand.trim() !== '') {
      return {
        arguments: { ...current, command: innerCommand },
        changed: true,
        note: 'extracted command from nested object wrapper'
      }
    }
  }
  const argSummary = safeStringifySlice(current, 200)
  return {
    arguments: { ...current, command: BASH_INVALID_COMMAND_STUB },
    changed: true,
    note: `repaired invalid bash call with non-string command (args=${argSummary})`
  }
}

/** 安全序列化，循环引用/异常时兜底，避免整轮 turn 因 stringify 抛错。 */
function safeStringifySlice(value: unknown, max: number): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? String(value)
  } catch {
    serialized = String(value)
  }
  return serialized.slice(0, max)
}

function shallowCloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value }
}

function flattenWrapper(
  raw: Record<string, unknown>
): { arguments: Record<string, unknown>; note: string } | null {
  for (const key of WRAPPER_KEYS) {
    if (!(key in raw)) continue
    if (!canFlattenWrapper(raw, key)) continue
    const value = raw[key]
    const parsed = valueToObject(value)
    if (!parsed) continue
    return {
      arguments: parsed,
      note: `flattened ${key} wrapper`
    }
  }
  return null
}

function canFlattenWrapper(raw: Record<string, unknown>, wrapperKey: string): boolean {
  const keys = Object.keys(raw)
  if (keys.length === 1) return true
  return keys.every((key) => key === wrapperKey || TOOL_METADATA_KEYS.has(key))
}

function scavengeSingleJsonString(
  raw: Record<string, unknown>,
  skipKey?: string
): { arguments: Record<string, unknown>; note: string } | null {
  const entries = Object.entries(raw)
  if (entries.length !== 1) return null
  const [key, value] = entries[0] ?? []
  if (key === skipKey) return null
  if (!key || typeof value !== 'string') return null
  const parsed = parseJsonishObject(value)
  if (!parsed) return null
  return {
    arguments: parsed,
    note: `scavenged JSON object from ${key}`
  }
}

function valueToObject(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return { ...value }
  if (typeof value === 'string') return parseJsonishObject(value)
  return null
}

function parseJsonishObject(text: string): Record<string, unknown> | null {
  const candidates = [
    text.trim(),
    stripMarkdownFence(text.trim()),
    extractFirstJsonObject(text)
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (isPlainObject(parsed)) return { ...parsed }
    } catch {
      // Try the next repair candidate.
    }
  }
  return null
}

function truncateOversizedStrings(
  value: Record<string, unknown>,
  options: { maxStringBytes: number; preserveLongStrings: boolean }
): { value: Record<string, unknown>; changed: boolean; count: number } {
  if (options.preserveLongStrings) return { value, changed: false, count: 0 }
  const state = { changed: false, count: 0 }
  const next = truncateValue(value, options.maxStringBytes, state)
  return {
    value: isPlainObject(next) ? next : value,
    changed: state.changed,
    count: state.count
  }
}

function truncateValue(
  value: unknown,
  maxBytes: number,
  state: { changed: boolean; count: number }
): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
    state.changed = true
    state.count += 1
    return `${sliceUtf8(value, maxBytes)}\n...[truncated by Legalwork tool argument repair]`
  }
  if (Array.isArray(value)) return value.map((item) => truncateValue(item, maxBytes, state))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = truncateValue(child, maxBytes, state)
  }
  return out
}

function stripMarkdownFence(text: string): string {
  const fence = /^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i.exec(text)
  return fence?.[1]?.trim() ?? text
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

function sliceUtf8(value: string, maxBytes: number): string {
  let used = 0
  let out = ''
  for (const char of value) {
    const next = Buffer.byteLength(char, 'utf8')
    if (used + next > maxBytes) break
    out += char
    used += next
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
