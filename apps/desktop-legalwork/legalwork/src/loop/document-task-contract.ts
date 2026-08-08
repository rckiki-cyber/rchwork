import type { TurnItem } from '../contracts/items.js'

export type DocumentTaskContract = {
  minimumContentCharacters?: number
  requiredHeadings: string[]
  minimumCaseCount?: number
  requiredFilenameFragment?: string
  forbidPlaceholders: boolean
  requiredKnowledgePdfReads: number
  requiresDesensitization: boolean
}

/**
 * Extract only explicit requirements that the runtime can verify without
 * judging writing quality. This turns long, multi-stage prompts into durable
 * completion gates instead of relying on the model to remember a checklist.
 */
export function documentTaskContract(prompt: string): DocumentTaskContract {
  const lengthMatch = prompt.match(/(?:不少于|至少|不低于)\s*([\d,，]+)\s*(?:个)?\s*(?:中文)?\s*字/i)
  const parsedMinimum = lengthMatch?.[1]
    ? Number.parseInt(lengthMatch[1].replace(/[,，]/g, ''), 10)
    : undefined
  const minimumContentCharacters = parsedMinimum && Number.isFinite(parsedMinimum)
    ? Math.min(Math.max(parsedMinimum, 1), 200_000)
    : undefined

  const requiredHeadings: string[] = []
  for (const line of prompt.split(/\r?\n/)) {
    const match = line.match(/^\s*[-+*]\s*(?:\*\*)?((?:[一二三四五六七八九十百]+、|参考文献)[^\n*]*)/)
    const rawHeading = match?.[1]?.trim()
    const heading = rawHeading?.startsWith('参考文献') ? '参考文献' : rawHeading
    if (heading && !requiredHeadings.includes(heading)) requiredHeadings.push(heading)
  }

  const caseMatch = prompt.match(/(?:分析|研究|梳理)\s*(\d+)\s*(?:[-–—~至到]\s*\d+)?\s*个\s*(?:典型)?\s*案例/)
  const minimumCaseCount = caseMatch?.[1]
    ? Math.min(Math.max(Number.parseInt(caseMatch[1], 10), 1), 20)
    : undefined
  const filenameMatch = prompt.match(/文件名(?:中)?(?:需|必须)?\s*含\s*[「“"]([^」”"]+)[」”"]/) ??
    prompt.match(/文件名.{0,8}[「“"]([^」”"]+)[」”"]/)
  const requestedPdfReads = /(?:OCR|光学字符识别)/i.test(prompt) && /PDF/i.test(prompt)
    ? Number.parseInt(prompt.match(/(?:至少|不少于)\s*(\d+)\s*篇/)?.[1] ?? '1', 10)
    : 0

  return {
    ...(minimumContentCharacters ? { minimumContentCharacters } : {}),
    requiredHeadings,
    ...(minimumCaseCount ? { minimumCaseCount } : {}),
    ...(filenameMatch?.[1]?.trim() ? { requiredFilenameFragment: filenameMatch[1].trim() } : {}),
    forbidPlaceholders: /(?:禁止|不得|不允许).{0,12}(?:省略号|占位符|省略|待补充)/s.test(prompt),
    requiredKnowledgePdfReads: Math.min(Math.max(requestedPdfReads || 0, 0), 10),
    requiresDesensitization: /(?:执行|进行|演示|产出).{0,16}脱敏|脱敏处理演示|脱敏后(?:的)?版本/s.test(prompt)
  }
}

function normalizedDocumentText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/<!--[^]*?-->/g, '')
    .replace(/[\s#>*_\u0060~|\[\](){}]/g, '')
}

function normalizedRequirement(value: string): string {
  return value.normalize('NFKC').replace(/[\s：:()（）、，,.。；;\-_—]/g, '')
}

function caseNumbersIn(value: string): Set<string> {
  const matches = value.matchAll(/[（(]\s*\d{4}\s*[）)]\s*[^\s，。；;]{1,24}?号/g)
  return new Set([...matches].map((match) => match[0].replace(/\s+/g, '')))
}

export function validateDocumentContent(
  content: string,
  contract: DocumentTaskContract
): string[] {
  const issues: string[] = []
  const normalized = normalizedDocumentText(content)
  if (contract.minimumContentCharacters && normalized.length < contract.minimumContentCharacters) {
    issues.push(`正文仅 ${normalized.length} 字，用户要求不少于 ${contract.minimumContentCharacters} 字`)
  }
  const normalizedContent = normalizedRequirement(content)
  for (const heading of contract.requiredHeadings) {
    if (!normalizedContent.includes(normalizedRequirement(heading))) {
      issues.push(`缺少必需章节“${heading}”`)
    }
  }
  if (contract.minimumCaseCount) {
    const caseCount = caseNumbersIn(content).size
    if (caseCount < contract.minimumCaseCount) {
      issues.push(`仅检出 ${caseCount} 个不同案号，用户要求至少 ${contract.minimumCaseCount} 个典型案例`)
    }
  }
  if (
    contract.forbidPlaceholders &&
    /(?:…+|\.{3,}|TBD|TODO|待补充|待完善|占位符|此处省略)/i.test(content)
  ) {
    issues.push('文档含有用户明确禁止的省略号或占位内容')
  }
  if (contract.requiresDesensitization && !/脱敏|去标识化|匿名化/.test(content)) {
    issues.push('报告未体现用户要求的脱敏处理成果与策略')
  }
  return issues
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function meaningfulEvidenceText(value: unknown): boolean {
  return typeof value === 'string' && value.replace(/\s+/g, '').length >= 20
}

export function successfulKnowledgePdfReadPaths(
  items: readonly TurnItem[],
  turnId: string
): Set<string> {
  const paths = new Set<string>()
  for (const item of items) {
    if (
      item.turnId !== turnId || item.kind !== 'tool_result' ||
      item.toolName !== 'knowledge_read_file' || item.isError === true
    ) continue
    const output = objectRecord(item.output)
    const path = typeof output.path === 'string' ? output.path.trim() : ''
    const content = typeof output.content === 'string' ? output.content : ''
    if (path && /\.pdf$/i.test(path) && meaningfulEvidenceText(content)) paths.add(path)
  }
  return paths
}

export function hasSuccessfulDesensitization(
  items: readonly TurnItem[],
  turnId: string
): boolean {
  return items.some((item) => {
    if (
      item.turnId !== turnId || item.kind !== 'tool_result' ||
      item.toolName !== 'data_compliance' || item.isError === true
    ) return false
    const output = objectRecord(item.output)
    return output.product_type === 'desensitize' && output.status === 'completed'
  })
}

export function successfullyVerifiedDraft(
  items: readonly TurnItem[],
  turnId: string
): string | undefined {
  const successfulCallIds = new Set<string>()
  for (const item of items) {
    if (
      item.turnId === turnId && item.kind === 'tool_result' &&
      item.toolName === 'knowledge_citation_verify' && item.isError !== true &&
      objectRecord(item.output).verificationPassed === true
    ) successfulCallIds.add(item.callId)
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (
      item?.turnId === turnId && item.kind === 'tool_call' &&
      item.toolName === 'knowledge_citation_verify' && successfulCallIds.has(item.callId) &&
      typeof item.arguments.draft === 'string'
    ) return item.arguments.draft
  }
  return undefined
}

export function taskContractInstruction(input: {
  contract: DocumentTaskContract
  readPdfCount: number
  desensitizationCompleted: boolean
}): string | undefined {
  const requirements: string[] = []
  if (input.contract.minimumContentCharacters) {
    requirements.push(
      `正文不少于 ${input.contract.minimumContentCharacters} 字（运行时会检查完整 content）`
    )
  }
  if (input.contract.requiredHeadings.length) {
    requirements.push(`必须包含全部章节：${input.contract.requiredHeadings.join('；')}`)
  }
  if (input.contract.minimumCaseCount) {
    requirements.push(`至少 ${input.contract.minimumCaseCount} 个不同、可核验的案号`)
  }
  if (input.contract.requiredFilenameFragment) {
    requirements.push(`文件名必须包含“${input.contract.requiredFilenameFragment}”`)
  }
  if (input.contract.forbidPlaceholders) {
    requirements.push('禁止省略号、TBD/TODO、待补充等占位内容')
  }
  if (input.contract.requiredKnowledgePdfReads) {
    requirements.push(
      `必须用 knowledge_read_file 实际读取 ${input.contract.requiredKnowledgePdfReads} 篇不同 PDF；已完成 ${input.readPdfCount} 篇`
    )
  }
  if (input.contract.requiresDesensitization) {
    requirements.push(
      `必须实际执行 data_compliance 脱敏；当前${input.desensitizationCompleted ? '已完成' : '未完成'}`
    )
  }
  if (!requirements.length) return undefined
  return [
    '<explicit_task_contract>',
    '以下是从用户原始请求中提取的强制验收条件，未全部通过前不得声称完成：',
    ...requirements.map((requirement) => `- ${requirement}`),
    '引用核验必须提交完整终稿；生成 Word 时必须使用同一份已核验终稿。',
    '</explicit_task_contract>'
  ].join('\n')
}

export function normalizedFinalDraft(value: string): string {
  return value.normalize('NFKC').replace(/\r\n/g, '\n').trim()
}
