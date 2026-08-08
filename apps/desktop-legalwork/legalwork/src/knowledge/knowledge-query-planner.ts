const MAX_ORIGINAL_QUERY_CHARS = 800
const MAX_FOCUSED_QUERY_CHARS = 320
const LONG_QUERY_THRESHOLD = 80
const TASK_WITH_OUTPUT_THRESHOLD = 40
const MAX_FOCUS_CLAUSES = 2
const MAX_ALIAS_GROUPS = 2

const LEGAL_QUERY_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ['非现场监管', '电子技术监控', '电子监控执法', '远程监管'],
  ['自动化决策', '算法行政', '算法决策', '算法治理'],
  ['算法裁量', '自动化行政裁量', '机器裁量'],
  ['说明理由', '算法解释', '可解释性'],
  ['个人信息保护', '隐私保护', '数据保护'],
  ['责任归属', '责任分配', '责任承担']
]

const LEGAL_SIGNAL_RE = /法律|法规|法条|司法解释|规范性文件|案例|判例|裁判|法院|检察|合同|协议|违约|解除|劳动|工伤|公司|股权|行政|诉讼|仲裁|证据|合规|监管|政策|个人信息|数据|隐私|算法|人工智能|知识产权|专利|商标|著作权|反不正当竞争|侵权|刑事|民事|商事|请求权|效力|管辖|时效|赔偿|责任/
const STRONG_ANCHOR_RE = /《[^》]{2,80}》|第[零〇一二三四五六七八九十百千万两\d]{1,10}条(?:之[零〇一二三四五六七八九十百千万两\d]{1,6})?|[（(]\d{4}[）)][^\s，。；;]{1,36}号|\b[A-Z]{2,10}\d{2,}\b/i
const TASK_SCAFFOLD_RE = /请|帮我|麻烦|需要|希望|认真|详细|全面|结合|根据|基于|围绕|分析|研究|梳理|总结|解释|回答|起草|撰写|生成|写一份|给出|提出/
const OUTPUT_FORMAT_RE = /输出|格式|字数|篇幅|markdown|md|word|docx|ppt|表格|分点|分条|标题|一级标题|二级标题|报告|文书|论文结构|目录|脚注|参考文献/i

export function buildKnowledgeRetrievalQueries(rawQuery: string): string[] {
  const normalized = normalizeQuery(rawQuery)
  if (!normalized) return []

  const original = boundQuery(normalized, MAX_ORIGINAL_QUERY_CHARS)
  const shouldFocus = normalized.length > LONG_QUERY_THRESHOLD || (
    normalized.length > TASK_WITH_OUTPUT_THRESHOLD &&
    LEGAL_SIGNAL_RE.test(normalized) &&
    OUTPUT_FORMAT_RE.test(normalized)
  )
  const aliasQuery = buildLegalAliasQuery(normalized)
  if (!shouldFocus) return uniqueQueries([original, aliasQuery])

  const focused = buildFocusedQuery(normalized)
  if (!focused || focused === original) return uniqueQueries([original, aliasQuery])

  // Keep the original query as a recall fallback. The retrieval pipeline fuses
  // both result lists deterministically, so query focusing can improve signal
  // without making long legal-task prompts lose a material factual constraint.
  return uniqueQueries([focused, aliasQuery, original])
}

function buildLegalAliasQuery(query: string): string {
  const matchedGroups = LEGAL_QUERY_ALIAS_GROUPS
    .filter((group) => group.some((term) => query.includes(term)))
    .slice(0, MAX_ALIAS_GROUPS)
  if (!matchedGroups.length) return ''
  return boundQuery(
    matchedGroups.flatMap((group) => group).join(' '),
    MAX_FOCUSED_QUERY_CHARS
  )
}

function uniqueQueries(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function buildFocusedQuery(query: string): string {
  const clauses = query
    .split(/[。！？!?；;\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 4)

  if (clauses.length === 0) return boundQuery(query, MAX_FOCUSED_QUERY_CHARS)

  const ranked = clauses
    .map((clause, index) => ({
      clause,
      index,
      score: focusScore(clause)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)

  const selected = ranked
    .filter((entry) => entry.score > 0)
    .slice(0, MAX_FOCUS_CLAUSES)
    .sort((left, right) => left.index - right.index)
    .map((entry) => stripTaskScaffold(entry.clause))
    .filter(Boolean)

  const focused = normalizeQuery(selected.join(' '))
  return boundQuery(focused || query, MAX_FOCUSED_QUERY_CHARS)
}

function focusScore(clause: string): number {
  let score = 0
  if (STRONG_ANCHOR_RE.test(clause)) score += 12
  if (LEGAL_SIGNAL_RE.test(clause)) score += 7
  if (/\d/.test(clause)) score += 2
  if (TASK_SCAFFOLD_RE.test(clause)) score -= 2
  // Output-shape instructions are useful for generation but harmful retrieval
  // features. Penalize them even when the phrase itself contains a legal word
  // such as “法律意见书”.
  if (OUTPUT_FORMAT_RE.test(clause)) score -= 12
  score += Math.min(4, Math.max(0, Math.floor(clause.length / 36)))
  return score
}

function stripTaskScaffold(clause: string): string {
  return clause
    .replace(/^(?:请|麻烦|帮我|需要你|希望你|你需要|我希望你|认真|详细|全面)+/g, '')
    .replace(/(?:请)?(?:分析|研究|梳理|总结|解释|回答|起草|撰写|生成|给出|提出)(?:一下|下)?/g, ' ')
    .replace(/(?:按照|采用|使用).{0,20}(?:格式|结构|方式)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeQuery(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
}

function boundQuery(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const head = Math.max(1, Math.floor(maxChars * 0.7))
  const tail = Math.max(1, maxChars - head - 1)
  return `${value.slice(0, head)} ${value.slice(-tail)}`.trim()
}
