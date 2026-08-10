const NUMBERED_PLAN_ITEM = /^(?:[-*•]\s*)?(\d{1,2})[.)、：:]\s*(.*)$/
const BULLETED_PLAN_ITEM = /^(?:[-*•])\s+(.*)$/
const EXECUTION_LOG_PREFIX = /^(?:先?检查|调用|尝试|现在|接下来|然后|开始检索|开始执行|已调用|已检索|当前工具|工具列表|用户提到|让我|let me|i(?:'ll| will| need to| should)|now |next |then )/i
const EXPLICIT_PLAN_CUE = /^(?:#{1,6}\s*)?(?:调研)?规划(?:步骤|编号|安排|如下)?\s*[：:]?$/
const META_CONTEXT = /(?:根据|按照)(?:系统|用户).{0,8}(?:指示|要求)|系统指示|用户要求|我应该|所以结构|先检查可用/i
const NON_PLAN_CONTENT = /(?:需要先形成(?:调研)?规划|形成调研规划(?:（|\()?(?:编号|列表)|编号列表|每完成.{0,12}(?:检索)?阶段|(?:简短|独立)消息(?:说明|播报)?|阶段播报|最终报告(?:作为|放在|输出)?|最后一条(?:独立)?回复|可见过程|全部使用中文|Markdown|active\s+skill|(?:检查|确认|看看).{0,12}(?:工具|skill|MCP).{0,8}(?:可用|广告|提供|列表)|当前(?:会话|工具列表)|我(?:应该|需要|将要)|用户(?:要求|提到)|不要输出|不得输出)/i
const RESEARCH_ACTION = /核验|检索|查明|确认|比较|比对|分析|梳理|识别|复核|查询|搜索|查找|归纳|评估|验证|提取|定位|考察|整理|综合|来源安排|法律框架|法规|案例|争议焦点|风险/

type PlanCandidate = {
  items: string[]
  rawItemCount: number
  explicitCue: boolean
  metaContext: boolean
}

function cleanPlanItem(value: string): string {
  return value
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*\*(.*?)\*\*$/, '$1')
    .trim()
}

function splitInlineNumberedItems(text: string): string {
  return text.replace(/\s+(?=\d{1,2}[.)、：:]\s+)/g, '\n')
}

function uniqueItems(items: string[]): string[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.replace(/[\s，。；;：:]+/g, '').toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isUsefulPlanItem(item: string): boolean {
  return Boolean(item) && !NON_PLAN_CONTENT.test(item) && !EXECUTION_LOG_PREFIX.test(item)
}

function candidateScore(candidate: PlanCandidate): number {
  const actionable = candidate.items.filter((item) => RESEARCH_ACTION.test(item)).length
  const rejected = Math.max(0, candidate.rawItemCount - candidate.items.length)
  return (
    (candidate.explicitCue ? 20 : 0) +
    candidate.items.length * 4 +
    actionable * 2 -
    rejected * 5 -
    (candidate.metaContext ? 12 : 0)
  )
}

function numberedPlanCandidates(lines: string[]): PlanCandidate[] {
  const candidates: PlanCandidate[] = []
  let rawItems: string[] = []
  let lastNumber = 0
  let startIndex = -1

  const finish = (): void => {
    if (!rawItems.length) return
    const previousLine = startIndex > 0 ? lines[startIndex - 1] ?? '' : ''
    const items = uniqueItems(rawItems.map(cleanPlanItem).filter(isUsefulPlanItem))
    candidates.push({
      items,
      rawItemCount: rawItems.length,
      explicitCue: EXPLICIT_PLAN_CUE.test(previousLine),
      metaContext: META_CONTEXT.test(previousLine)
    })
    rawItems = []
    lastNumber = 0
    startIndex = -1
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = line.match(NUMBERED_PLAN_ITEM)
    if (match) {
      const number = Number(match[1])
      if (rawItems.length && number <= lastNumber) finish()
      if (!rawItems.length) startIndex = index
      rawItems.push(match[2] ?? '')
      lastNumber = number
      continue
    }

    if (!rawItems.length) continue
    if (
      EXPLICIT_PLAN_CUE.test(line) ||
      EXECUTION_LOG_PREFIX.test(line) ||
      BULLETED_PLAN_ITEM.test(line)
    ) {
      finish()
      continue
    }
    rawItems[rawItems.length - 1] = `${rawItems[rawItems.length - 1]} ${line}`.trim()
  }
  finish()
  return candidates
}

/**
 * Extracts the best explicit, actionable plan from streamed reasoning text.
 * Models often repeat numbered system requirements before producing a real
 * plan, so selecting the first numbered list leaks meta-reasoning into the UI.
 */
export function extractResearchPlanItems(reasoning: string): string[] {
  const lines = splitInlineNumberedItems(reasoning.replace(/\r/g, ''))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const numberedCandidates = numberedPlanCandidates(lines)
    .filter((candidate) => candidate.items.length > 0)
    .sort((left, right) => candidateScore(right) - candidateScore(left))

  if (numberedCandidates.length) return numberedCandidates[0]?.items ?? []

  const bulletedItems: string[] = []
  let readingBulletedPlan = false
  for (const line of lines) {
    const match = line.match(BULLETED_PLAN_ITEM)
    if (match) {
      readingBulletedPlan = true
      const content = cleanPlanItem(match[1] ?? '')
      if (isUsefulPlanItem(content)) bulletedItems.push(content)
      continue
    }
    if (readingBulletedPlan && EXECUTION_LOG_PREFIX.test(line)) break
  }
  if (bulletedItems.length) return uniqueItems(bulletedItems)

  const fallback = reasoning
    .split(/(?<=[。！？.!?])\s*/)
    .map(cleanPlanItem)
    .filter(isUsefulPlanItem)

  return uniqueItems(fallback)
}

export function isResearchPlanMessage(text: string): boolean {
  const normalized = text.replace(/\r/g, '').trim()
  if (!normalized) return false

  const headingMatch = /(?:^|\n)\s*(?:#{1,6}\s*)?\*{0,3}\s*调研规划\s*\*{0,3}\s*(?:[：:]\s*)?(?:\n|$)/.exec(normalized)
  if (!headingMatch || (headingMatch.index ?? 0) > 240) return false
  if (/(?:第[一二三四五六七八九十\d]+阶段|阶段\s*[一二三四五六七八九十\d]+).{0,8}(?:完成|结果)/.test(normalized)) {
    return false
  }
  return extractResearchPlanItems(normalized).length > 0
}

export function formatResearchPlanIndex(index: number): string {
  return String(index + 1).padStart(2, '0')
}

const CHINESE_NUMERALS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20
}

/**
 * Extract the stage number the model itself wrote at the start of a stage
 * announcement (e.g. "阶段四（案例检索）已完成" → 4). The model may skip or
 * reorder stages, so the display number should follow its own numbering
 * instead of the frontend's sequential index.
 */
export function extractStageNumber(text: string): number | null {
  const normalized = text.replace(/\r/g, '').trim()
  if (!normalized) return null
  // Supports both "阶段四…" and "第5阶段…" forms the model may use.
  const match = /^(?:#+\s*)?\*{0,3}\s*(?:阶段\s*([一二三四五六七八九十]+|\d{1,2})|第\s*([一二三四五六七八九十]+|\d{1,2})\s*阶段)/.exec(normalized)
  if (!match) return null
  const raw = (match[1] ?? match[2] ?? '').trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) {
    const num = Number(raw)
    return Number.isInteger(num) && num >= 1 && num <= 99 ? num : null
  }
  return CHINESE_NUMERALS[raw] ?? null
}
