import type { TurnItem } from '../contracts/items.js'

export type DocumentTaskContract = {
  minimumContentCharacters?: number
  requiredHeadings: string[]
  requiredTopicTerms: string[]
  minimumCaseCount?: number
  requiredFilenameFragment?: string
  requiredArtifactFilenameFragments?: Partial<Record<'docx' | 'pdf' | 'pptx' | 'xlsx', string>>
  forbidPlaceholders: boolean
  requiredKnowledgePdfReads: number
  requiresDesensitization: boolean
}

const GENERIC_TOPIC_TERMS = new Set([
  '这篇论文', '该论文', '本文', '论文', '报告', '研究报告', '文献综述',
  '典型案例', '相关案例', '参考文献', '主要内容'
])

/**
 * Preserve explicit subject phrases as machine-checkable completion anchors.
 * This is intentionally conservative: a false negative here would block a
 * valid document, so only clauses introduced by clear research verbs or
 * quoted topic markers are retained.
 */
export function requiredTopicTerms(prompt: string): string[] {
  const candidates: string[] = []
  for (const match of prompt.matchAll(/(?:以|围绕|关于|主题(?:是|为)?|题为)\s*[「“"]([^」”"\n]{4,80})[」”"]/g)) {
    if (match[1]) candidates.push(match[1])
  }
  // Unquoted clause extraction is reserved for runtime-composed follow-ups.
  // On a one-shot complex prompt, verbs such as "分析 3 个案例" describe a
  // workflow stage rather than the document's subject and would be too noisy.
  if (prompt.includes('当前追问：')) {
    for (const match of prompt.matchAll(
      /(?:查一下|研究|分析|围绕|关于|写一篇关于|撰写一篇关于)\s*([^。！？\n]{4,100}?)(?:的?(?:案例|论文|报告|文献综述)|[。！？\n]|$)/g
    )) {
      if (match[1]) candidates.push(...match[1].split(/[，,；;：:]/))
    }
  }

  const terms: string[] = []
  for (const raw of candidates) {
    const term = raw
      .normalize('NFKC')
      .replace(/^\s*(?:对|就|以|围绕|关于)\s*/, '')
      .replace(/\s*(?:里|中|方面|相关|具体|贯彻|实施|研究|分析|问题|主题|的|之)\s*$/, '')
      .replace(/\s+/g, '')
      .trim()
    if (
      term.length < 4 || term.length > 32 ||
      /\d/.test(term) || /(?:典型|相关|若干)$/.test(term) ||
      GENERIC_TOPIC_TERMS.has(term)
    ) continue
    if (!terms.includes(term)) terms.push(term)
    if (terms.length >= 4) break
  }
  return terms
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
  let currentSection = ''
  for (const line of prompt.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*#{1,6}\s+(.+?)\s*$/)
    if (sectionMatch?.[1]) currentSection = sectionMatch[1]
    // A multi-artifact request often lists Word/report chapters and then PPT
    // slide titles with the same Chinese ordinal syntax. Only report chapters
    // belong in the Word content contract.
    if (/(?:PPTX?|演示文稿|幻灯片|普法宣传材料制作)/i.test(currentSection)) continue
    const match = line.match(/^\s*[-+*]\s*(?:\*\*)?((?:[一二三四五六七八九十百]+、|参考文献)[^\n*]*)/)
    const rawHeading = match?.[1]?.trim()
    const heading = rawHeading?.startsWith('参考文献') ? '参考文献' : rawHeading
    if (heading && !requiredHeadings.includes(heading)) requiredHeadings.push(heading)
  }

  const caseMatch = prompt.match(/(?:分析|研究|梳理|检索)\s*(\d+)\s*(?:[-–—~至到]\s*\d+)?\s*个\s*(?:典型|相关)?\s*案例/)
  const minimumCaseCount = caseMatch?.[1]
    ? Math.min(Math.max(Number.parseInt(caseMatch[1], 10), 1), 20)
    : undefined
  const filenameMatch = prompt.match(/文件名(?:中)?(?:需|必须)?\s*含\s*[「“"]([^」”"]+)[」”"]/) ??
    prompt.match(/文件名.{0,8}[「“"]([^」”"]+)[」”"]/)
  const requiredArtifactFilenameFragments: Partial<Record<'docx' | 'pdf' | 'pptx' | 'xlsx', string>> = {}
  for (const line of prompt.split(/\r?\n/)) {
    const match = line.match(/文件名(?:中)?(?:需|必须)?\s*含\s*[「“"]([^」”"]+)[」”"]/) ??
      line.match(/文件名.{0,8}[「“"]([^」”"]+)[」”"]/)
    const fragment = match?.[1]?.trim()
    if (!fragment) continue
    if (/(?:Word|DOCX|\.docx)/i.test(line)) requiredArtifactFilenameFragments.docx = fragment
    if (/(?:PPTX?|\.pptx|演示文稿|幻灯片)/i.test(line)) requiredArtifactFilenameFragments.pptx = fragment
    if (/(?:PDF|\.pdf)/i.test(line)) requiredArtifactFilenameFragments.pdf = fragment
    if (/(?:Excel|XLSX|\.xlsx|工作簿)/i.test(line)) requiredArtifactFilenameFragments.xlsx = fragment
  }
  if (
    requiredArtifactFilenameFragments.docx &&
    !requiredArtifactFilenameFragments.pdf &&
    /同一(?:份)?报告.{0,12}(?:生成|导出|转换为?)\s*PDF/is.test(prompt)
  ) {
    requiredArtifactFilenameFragments.pdf = requiredArtifactFilenameFragments.docx
  }
  const requestedPdfReads = /(?:OCR|光学字符识别)/i.test(prompt) && /PDF/i.test(prompt)
    ? Number.parseInt(prompt.match(/(?:至少|不少于)\s*(\d+)\s*篇/)?.[1] ?? '1', 10)
    : 0

  return {
    ...(minimumContentCharacters ? { minimumContentCharacters } : {}),
    requiredHeadings,
    requiredTopicTerms: requiredTopicTerms(prompt),
    ...(minimumCaseCount ? { minimumCaseCount } : {}),
    ...(filenameMatch?.[1]?.trim() ? { requiredFilenameFragment: filenameMatch[1].trim() } : {}),
    ...(Object.keys(requiredArtifactFilenameFragments).length
      ? { requiredArtifactFilenameFragments }
      : {}),
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
  // Topic adherence is left to the model. A fixed substring match is too
  // brittle (phrasing/word-order varies between the request and the draft) and
  // ends up rejecting on-topic documents. The contract enforces only hard,
  // mechanical requirements (length, headings, case count, placeholders).
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
    /(?:TBD|TODO|待补充|待完善|占位符|此处省略|内容略|详见下文)/i.test(content)
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
    const output = item.kind === 'tool_result' ? objectRecord(item.output) : {}
    const documentStats = objectRecord(output.documentStats)
    const totalCitations = documentStats.totalCitations
    if (
      item.turnId === turnId && item.kind === 'tool_result' &&
      item.toolName === 'knowledge_citation_verify' && item.isError !== true &&
      output.verificationPassed === true &&
      // Keep compatibility with older/custom verification tools that did not
      // return documentStats, but never accept an explicit zero-citation pass.
      (typeof totalCitations !== 'number' || totalCitations > 0)
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
  if (input.contract.requiredTopicTerms.length) {
    requirements.push(`正文与标题必须持续覆盖原始主题：${input.contract.requiredTopicTerms.join('；')}`)
  }
  if (input.contract.minimumCaseCount) {
    requirements.push(`至少 ${input.contract.minimumCaseCount} 个不同、可核验的案号`)
  }
  if (input.contract.requiredFilenameFragment) {
    requirements.push(`文件名必须包含“${input.contract.requiredFilenameFragment}”`)
  }
  if (input.contract.requiredArtifactFilenameFragments) {
    for (const [kind, fragment] of Object.entries(input.contract.requiredArtifactFilenameFragments)) {
      if (fragment) requirements.push(`${kind.toUpperCase()} 文件名必须包含“${fragment}”`)
    }
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
