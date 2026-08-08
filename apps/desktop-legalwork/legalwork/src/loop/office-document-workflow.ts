import type { TurnItem } from '../contracts/items.js'
import { OFFICECLI_TOOL_NAME } from '../adapters/tool/office-fallback-policy.js'

export { OFFICECLI_TOOL_NAME }

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
 * OfficeCLI is no longer the primary document executor. If this instruction is
 * present, the runtime has already granted a turn-scoped last-resort fallback.
 * Keep the fallback narrow so it cannot recreate the previous tool storm.
 */
export function officeDocumentWorkflowInstruction(
  input: OfficeDocumentWorkflowInput
): string | undefined {
  if (!input.officeCliAvailable) return undefined

  const calls = collectOfficeCliCalls(input.items, input.turnId)
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
  const atomicMutationCount = calls.filter((call) => BATCHABLE_OFFICECLI_VERBS.has(call.verb)).length
  const batchCount = calls.filter((call) => call.verb === 'batch').length
  const errorCount = [...results.values()].filter((result) => result.isError === true).length
  const repairsAfterValidation = successfulValidate
    ? calls.filter((call) =>
        call.itemIndex > successfulValidate.itemIndex && MUTATING_OFFICECLI_VERBS.has(call.verb)
      ).length
    : 0

  const notes: string[] = []
  if (atomicMutationCount >= 3 && batchCount === 0) {
    notes.push(`已出现 ${atomicMutationCount} 次逐条修改；后续必须合并 batch。`)
  }
  if (errorCount > 0) {
    notes.push(`已有 ${errorCount} 次 OfficeCLI 错误；不得原样重试失败参数。`)
  }
  if (successfulValidate) {
    notes.push(
      repairsAfterValidation > 0
        ? `validate 后又修改 ${repairsAfterValidation} 次；只复核这些修改，禁止重做整份文档。`
        : 'validate 已通过；没有实质错误就立即交付。'
    )
  }

  return [
    'Office MCP 已作为最后兜底临时解锁：',
    '- 只处理 legal-document-formatting 本地 worker 明确无法完成的剩余部分；不要重做已成功的本地步骤。',
    '- 禁止 view html；禁止为了查看格式把整篇文档 HTML/XML 放回 history。',
    '- 禁止反复 help；同类 set/add/remove 必须 batch。',
    '- 保存后最多做一次必要 validate；通过后立即结束，warning 不触发无休止抛光。',
    '- 工具输出只保留必要摘要，不复述日志。',
    ...notes
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
