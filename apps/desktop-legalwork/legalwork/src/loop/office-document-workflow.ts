import type { TurnItem } from '../contracts/items.js'

export const OFFICECLI_TOOL_NAME = 'mcp_officecli_officecli'

const DOCUMENT_INTENT_PATTERN =
  /(?:\b(?:word|docx)\b|Word\s*文档|(?:生成|创建|制作|写入|导出|整理|完善).{0,12}文档|文档.{0,12}(?:生成|创建|制作|写入|导出|整理|完善))/i
const MUTATING_OFFICECLI_VERBS = new Set([
  'create',
  'set',
  'add',
  'remove',
  'move',
  'swap',
  'batch',
  'raw'
])
const BATCHABLE_OFFICECLI_VERBS = new Set(['set', 'add', 'remove', 'move', 'swap', 'raw'])

type OfficeDocumentWorkflowInput = {
  prompt: string
  items: readonly TurnItem[]
  turnId: string
  officeCliAvailable: boolean
}

type OfficeCliCall = {
  callId: string
  verb: string
  itemIndex: number
}

/**
 * Adds a quality-preserving execution contract only for turns that are
 * actually creating/editing Office documents. The instruction is advisory:
 * it reduces mechanical tool chatter without imposing a time/call ceiling
 * that could cut off substantive content or necessary repairs.
 */
export function officeDocumentWorkflowInstruction(
  input: OfficeDocumentWorkflowInput
): string | undefined {
  if (!input.officeCliAvailable) return undefined

  const calls = collectOfficeCliCalls(input.items, input.turnId)
  if (!DOCUMENT_INTENT_PATTERN.test(input.prompt) && calls.length === 0) return undefined

  const results = new Map<string, Extract<TurnItem, { kind: 'tool_result' }>>()
  for (const item of input.items) {
    if (
      item.turnId === input.turnId &&
      item.kind === 'tool_result' &&
      isOfficeCliToolName(item.toolName)
    ) {
      results.set(item.callId, item)
    }
  }
  const successfulValidate = [...calls].reverse().find((call) => {
    const result = results.get(call.callId)
    return call.verb === 'validate' && result?.status === 'completed' && result.isError !== true
  })
  const atomicMutationCount = calls.filter((call) =>
    BATCHABLE_OFFICECLI_VERBS.has(call.verb)
  ).length
  const batchCount = calls.filter((call) => call.verb === 'batch').length
  const errorCount = [...results.values()].filter((result) => result.isError === true).length
  const repairsAfterValidation = successfulValidate
    ? calls.filter((call) =>
        call.itemIndex > successfulValidate.itemIndex && MUTATING_OFFICECLI_VERBS.has(call.verb)
      ).length
    : 0

  const stateNotes: string[] = []
  if (atomicMutationCount >= 3 && batchCount === 0) {
    stateNotes.push(
      `本轮已出现 ${atomicMutationCount} 次逐条文档修改；后续同类操作应合并为 batch，除非批量执行本身失败。`
    )
  }
  if (errorCount > 0) {
    stateNotes.push(
      `本轮已有 ${errorCount} 次 OfficeCLI 错误；不得原样重试失败参数，应先修正命令形态，批量失败时只重试失败子项。`
    )
  }
  if (successfulValidate) {
    stateNotes.push(
      repairsAfterValidation > 0
        ? `文档已验证通过，之后又执行了 ${repairsAfterValidation} 次修改；请立即复核这些修改，只在仍有实质质量问题时继续。`
        : '文档已经验证通过；将其视为交付检查点，只修复影响内容、结构或用户要求版式的问题。'
    )
  }

  return [
    'Office 文档任务执行约束（质量优先，减少机械浪费）：',
    '- 先确定完整内容、引证、层级和版式，再执行写入；不得为减少调用而删减用户要求或降低产物质量。',
    '- 三个及以上同类 add/set 操作优先使用 OfficeCLI batch；按章节或 5–20 个操作分组，保留失败后的局部重试能力。',
    '- batch 的每个元素使用裸 command 与同级 parent/path/type/props 字段；批量部分失败时只修复失败子项。',
    '- 同一失败命令不得原样重试；需要语法帮助时只查询一次，然后改变命令结构。',
    '- 完成主体写入后统一设置样式，随后 save、validate。验证通过后通常只进行一次有针对性的修复与复验；若仍存在实质问题则继续，纯提示性或不可见告警不应引发无休止抛光。',
    '- 工具操作必须通过真实工具调用发出。思考中不要编造“工具调用 N”清单，不要复述原始命令日志或长篇工具返回；只保留简洁的阶段判断。',
    '- 结束时说明产物位置和验证结果。',
    ...stateNotes
  ].join('\n')
}

function collectOfficeCliCalls(items: readonly TurnItem[], turnId: string): OfficeCliCall[] {
  const calls: OfficeCliCall[] = []
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex]
    if (
      !item ||
      item.turnId !== turnId ||
      item.kind !== 'tool_call' ||
      !isOfficeCliToolName(item.toolName)
    ) {
      continue
    }
    calls.push({
      callId: item.callId,
      verb: officeCliVerb(item.arguments.command),
      itemIndex
    })
  }
  return calls
}

function isOfficeCliToolName(toolName: string): boolean {
  return toolName === OFFICECLI_TOOL_NAME || toolName.toLowerCase() === 'officecli'
}

function officeCliVerb(command: unknown): string {
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === 'string')
    const offset = parts[0]?.toLowerCase() === 'officecli' ? 1 : 0
    return parts[offset]?.toLowerCase() ?? ''
  }
  if (typeof command !== 'string') return ''
  const trimmed = command.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return officeCliVerb(parsed)
    } catch {
      return ''
    }
  }
  const parts = trimmed.split(/\s+/)
  const offset = parts[0]?.toLowerCase() === 'officecli' ? 1 : 0
  return parts[offset]?.toLowerCase() ?? ''
}
