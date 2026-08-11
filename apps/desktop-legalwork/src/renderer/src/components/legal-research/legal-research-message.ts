const PLAN_HEADING = /(?:^|\n)\s*#{1,6}\s*调研规划\s*(?:\n|$)/m
const STAGE_START = /(?:^|\n)\s*(?:#{1,6}\s*)?\*{0,2}(?:(?:第\s*)?[一二三四五六七八九十\d]+\s*阶段(?:播报|进展|结果)?|检索阶段[^\n：:]*|阶段播报)\*{0,2}\s*[：:]?/m
const REPORT_START = /(?:^|\n)\s*#\s+(?!(?:调研规划|阶段|检索阶段))(?=[^\n]*(?:报告|法律意见|研究))(?:[^\n]+)|(?:^|\n)\s*#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.)．]?\s*)?(?:结论摘要|结论)(?=\s|[：:]|$)/m

const REPORT_SECTIONS = [
  /(?:^|\n)\s*#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.)．]?\s*)?(?:结论摘要|结论)(?=\s|[：:]|$)/m,
  /(?:^|\n)\s*#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.)．]?\s*)?(?:法律依据|规范依据)(?=\s|[：:]|$)/m,
  /(?:^|\n)\s*#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.)．]?\s*)?(?:相关案例|典型案例|案例分析)(?=\s|[：:]|$)/m,
  /(?:^|\n)\s*#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.)．]?\s*)?(?:分析与风险提示|法律分析|风险提示|分析)(?=\s|[：:]|$)/m,
  /(?:^|\n)\s*#{1,6}\s*(?:[一二三四五六七八九十\d]+[、.)．]?\s*)?(?:来源|参考资料|参考文献)(?=\s|[：:]|$)/m
]

export type LegalResearchMessageParts = {
  planning: string
  update: string
  report: string
  reportComplete: boolean
}

function matchIndex(text: string, pattern: RegExp): number {
  const match = pattern.exec(text)
  if (!match) return -1
  const rawIndex = match.index ?? -1
  if (rawIndex < 0) return -1
  return text[rawIndex] === '\n' ? rawIndex + 1 : rawIndex
}

export function isCompleteLegalResearchReportText(text: string): boolean {
  const normalized = text.replace(/\r/g, '').trim()
  if (normalized.length < 300) return false
  return REPORT_SECTIONS.filter((pattern) => pattern.test(normalized)).length >= 4
}

export function bestAvailableLegalResearchText(
  messages: readonly string[],
  reasoning = ''
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const report = splitLegalResearchMessage(messages[index] ?? '').report
    if (report) return report
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index]?.trim()
    if (text) return text
  }
  return reasoning.trim()
}

export function splitLegalResearchMessage(text: string): LegalResearchMessageParts {
  const normalized = text.replace(/\r/g, '').trim()
  if (!normalized) return { planning: '', update: '', report: '', reportComplete: false }

  const planStart = matchIndex(normalized, PLAN_HEADING)
  const stageStart = matchIndex(normalized, STAGE_START)
  const reportStart = matchIndex(normalized, REPORT_START)

  const reportCandidate = reportStart >= 0 ? normalized.slice(reportStart).trim() : ''
  const reportComplete = isCompleteLegalResearchReportText(reportCandidate)
  const report = reportCandidate
  const effectiveReportStart = reportStart

  let planning = ''
  if (planStart >= 0) {
    const endCandidates = [stageStart, effectiveReportStart].filter((index) => index > planStart)
    const end = endCandidates.length ? Math.min(...endCandidates) : normalized.length
    planning = normalized.slice(planStart, end).trim().replace(/\n---\s*$/, '').trim()
  }

  let update = ''
  if (stageStart >= 0) {
    const end = effectiveReportStart > stageStart ? effectiveReportStart : normalized.length
    update = normalized.slice(stageStart, end).trim()
  } else if (!planning && !report) {
    update = normalized
  }

  return { planning, update, report, reportComplete }
}
