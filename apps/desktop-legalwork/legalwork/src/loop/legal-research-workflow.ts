import type { TurnItem } from '../contracts/items.js'

const LEGAL_RESEARCH_PROMPT = /请对以下法律问题进行多源调研[：:]|最终报告必须作为最后一条独立回复/
const PLAN_HEADING = /(?:^|\n)\s*#{1,6}\s*调研规划\s*(?:\n|$)/
const NUMBERED_ITEM = /(?:^|\n)\s*\d{1,2}[.)、．]\s*\S/g

const REPORT_SECTION_PATTERNS = [
  /(?:^|\n)\s*#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.)．]?\s*)?(?:结论摘要|结论)(?=\s|[：:]|$)/m,
  /(?:^|\n)\s*#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.)．]?\s*)?(?:法律依据|规范依据)(?=\s|[：:]|$)/m,
  /(?:^|\n)\s*#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.)．]?\s*)?(?:相关案例|典型案例|案例分析)(?=\s|[：:]|$)/m,
  /(?:^|\n)\s*#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.)．]?\s*)?(?:分析与风险提示|法律分析|风险提示|分析)(?=\s|[：:]|$)/m,
  /(?:^|\n)\s*#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.)．]?\s*)?(?:来源|参考资料|参考文献)(?=\s|[：:]|$)/m
]

export function isLegalResearchWorkflowPrompt(prompt: string): boolean {
  return LEGAL_RESEARCH_PROMPT.test(prompt)
}

export function isPublishedLegalResearchPlan(text: string): boolean {
  if (!PLAN_HEADING.test(text)) return false
  return (text.match(NUMBERED_ITEM) ?? []).length >= 3
}

export function isCompleteLegalResearchReport(text: string): boolean {
  const normalized = text.replace(/\r/g, '').trim()
  if (normalized.length < 300) return false
  const matchedSections = REPORT_SECTION_PATTERNS.filter((pattern) => pattern.test(normalized)).length
  return matchedSections >= 4
}

export function hasPublishedLegalResearchPlan(
  items: readonly TurnItem[],
  turnId: string
): boolean {
  return items.some((item) =>
    item.turnId === turnId &&
    item.kind === 'assistant_text' &&
    isPublishedLegalResearchPlan(item.text)
  )
}

export function hasCompleteLegalResearchReport(
  items: readonly TurnItem[],
  turnId: string,
  currentText = ''
): boolean {
  const assistantText = items
    .filter((item): item is Extract<TurnItem, { kind: 'assistant_text' }> =>
      item.turnId === turnId && item.kind === 'assistant_text'
    )
    .map((item) => item.text)
  if (currentText.trim()) assistantText.push(currentText)
  return assistantText.some(isCompleteLegalResearchReport)
}

const PRIMARY_LEGAL_DATABASE = /(?:pkulaw|北大法宝|yuandian|元典)/i
const LEGAL_LINK_ENRICHMENT = /(?:doc[_-]?link|link[_-]?(?:enhance|resolve)|citation[_-]?(?:valid|verify)|链接增强|引证核验)/i

function serialized(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function nestedToolFailed(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.isError === true) return true
  return nestedToolFailed(record.result)
}

/** A law/case body returned by PKULaw or Yuandian is already primary legal evidence. */
export function hasUsablePrimaryLegalDatabaseEvidence(
  items: readonly TurnItem[],
  turnId: string
): boolean {
  return items.some((item) => {
    if (item.turnId !== turnId || item.kind !== 'tool_result' || item.isError === true) return false
    const payload = `${item.toolName}\n${serialized(item.output)}`
    if (!PRIMARY_LEGAL_DATABASE.test(payload) || LEGAL_LINK_ENRICHMENT.test(payload)) return false
    if (nestedToolFailed(item.output)) return false
    return payload.replace(/\s+/g, '').length >= 160
  })
}

/** The final synthesis can begin once a primary database also returned a case. */
export function hasUsablePrimaryLegalCaseEvidence(
  items: readonly TurnItem[],
  turnId: string
): boolean {
  return items.some((item) => {
    if (item.turnId !== turnId || item.kind !== 'tool_result' || item.isError === true) return false
    const payload = `${item.toolName}\n${serialized(item.output)}`
    if (!/(?:yuandian-case|pkulaw[^\s"/]*(?:case|al)|北大法宝.{0,12}案例|元典.{0,12}案例)/i.test(payload)) {
      return false
    }
    if (LEGAL_LINK_ENRICHMENT.test(payload) || nestedToolFailed(item.output)) return false
    return payload.replace(/\s+/g, '').length >= 160
  })
}

/** MCP discovery found a concrete PKULaw/Yuandian law or case tool to call. */
export function hasDiscoveredPrimaryLegalDatabaseTool(
  items: readonly TurnItem[],
  turnId: string
): boolean {
  return items.some((item) => {
    if (
      item.turnId !== turnId ||
      item.kind !== 'tool_result' ||
      item.toolName !== 'mcp_search' ||
      item.isError === true
    ) return false
    const payload = serialized(item.output)
    return PRIMARY_LEGAL_DATABASE.test(payload) &&
      /(?:law|statute|regulation|case|法规|法条|案例|裁判)/i.test(payload)
  })
}

/** Calls that add latency but no legal substance once a primary database succeeded. */
export function isRedundantLegalSourceEnrichmentCall(input: {
  toolName: string
  arguments: Record<string, unknown>
}): boolean {
  if (['web_search', 'web_fetch', 'knowledge_legal_external_sources'].includes(input.toolName)) {
    return true
  }
  const target = `${input.toolName}\n${serialized(input.arguments)}`
  return PRIMARY_LEGAL_DATABASE.test(target) && LEGAL_LINK_ENRICHMENT.test(target)
}

export function legalResearchStageInstruction(input: {
  planPublished: boolean
  reportComplete: boolean
}): string {
  if (!input.reportComplete) {
    return [
      '<legal_research_advisory>',
      input.planPublished
        ? '已有调研规划可供参考，无需重复规划。'
        : '可在内部简要规划，但不要把单独规划或阶段播报作为本轮唯一输出。',
      '按需使用当前可用来源；任一主要法律数据库已有可用内容后，不要为链接装饰或重复核验继续扩张检索。',
      '直接交付最佳可用的完整报告，建议用 Markdown 标题区分：结论、法律依据、相关案例、分析与风险提示、来源。来源不足或工具失败时标注局限并继续，不得吞掉报告正文。',
      '</legal_research_advisory>'
    ].join('\n')
  }
  return ''
}
