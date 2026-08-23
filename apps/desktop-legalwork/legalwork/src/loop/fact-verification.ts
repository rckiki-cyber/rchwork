import type { TurnItem } from '../contracts/items.js'
import type { LegalResearchPrimarySource } from '../contracts/capabilities.js'
import { isLegalResearchWorkflowPrompt } from './legal-research-workflow.js'

export const FACT_VERIFICATION_FINALIZE_TOOL_NAME = 'fact_verification_finalize'

export type FactVerificationContract = {
  required: boolean
  requiresWebEvidence: boolean
  requiresLegalEvidence: boolean
  minimumFetchedSources: number
  minimumClaims: number
}

export type FactVerificationProgress = {
  webSearchAttempts: number
  webSearchSatisfied: boolean
  webFetchAttempts: number
  fetchedSourceUrls: Set<string>
  legalSearchAttempts: number
  legalSourceUrls: Set<string>
  legalEvidenceSatisfied: boolean
  finalizeAttempts: number
  finalized: boolean
  finalizedClaimCount: number
}

/**
 * Current-policy/news questions cannot be answered safely from model memory.
 * Keep this separate from the optional broad fact-audit quality gate: freshness
 * is a correctness prerequisite, while a full multi-source ledger is an
 * optional delivery-quality workflow.
 */
export function requiresFreshWebSearch(prompt: string): boolean {
  if (prompt.includes('<inline_document_response>')) return false
  const compact = prompt.replace(/\s+/g, '')
  if (!compact) return false

  const freshnessSignal = /(?:最新|当前|现行|截至|近期|最近|今年|本月|今日|今天|刚刚|新出台|新发布|新修订)/.test(compact)
  const changingSubject = /(?:政策|规定|规则|要求|标准|资格|考试|公考|法考|考纲|大纲|法规|法律|司法解释|通知|公告|动态|消息|新闻|案例|判决|裁判)/.test(compact)
  const firstCaseSignal = /(?:首例|第一案)/.test(compact) &&
    /(?:法典|法律|法规|法院|判决|裁判|案件|案)/.test(compact)

  return (freshnessSignal && changingSubject) || firstCaseSignal
}

/**
 * Decide whether answering the user's request inherently requires a web
 * retrieval step. This is intentionally broader than freshness detection:
 * explicit search instructions and inherently changing public information
 * must not depend on the model voluntarily emitting a tool call.
 *
 * Source-specific requests are excluded so local knowledge, attachments and
 * configured legal databases keep their dedicated routing semantics.
 */
export function requiresWebSearch(prompt: string): boolean {
  if (prompt.includes('<inline_document_response>')) return false
  const compact = prompt.replace(/\s+/g, '')
  if (!compact) return false

  // Renderer-grounded knowledge answers already contain retrieved evidence.
  // Do not mistake words such as “检索到” inside that envelope for a new web
  // search request.
  if (/(?:RAG检索上下文|从知识库中检索到的相关内容|<knowledge_context>)/i.test(compact)) return false

  const optsOut = /(?:不要|无需|不用|不需要|禁止)(?:联网|上网|搜索|检索|查询|查找|使用网页|使用网络)|(?:仅|只)(?:根据|依据|使用)(?:已有内容|当前内容|附件|上传文件|本地文件)/.test(compact)
  if (optsOut) return false

  const dedicatedSource = /(?:本地知识库|本地资料库|上传(?:的)?(?:附件|文件)|当前附件|IMA|北大法宝|元典)(?:中|内|里)?(?:查|搜|检索|查询|查找|寻找|获取|研究)/i.test(compact) ||
    /(?:查|搜|检索|查询|查找|寻找|获取|研究).{0,16}(?:本地知识库|本地资料库|上传(?:的)?(?:附件|文件)|当前附件|IMA|北大法宝|元典)/i.test(compact)
  if (dedicatedSource) return false

  if (requiresFreshWebSearch(prompt)) return true

  const explicitWebSearch = /(?:联网|上网|网上|网页|网络|官网).{0,16}(?:查|搜|检索|搜索|查询|查找|寻找|获取)|(?:查|搜|检索|搜索|查询|查找|寻找|获取).{0,16}(?:联网|上网|网上|网页|网络|官网)/.test(compact)
  if (explicitWebSearch) return true

  const explicitGenericSearch = /(?:请|帮我|替我|给我|先|去|需要|麻烦)?(?:查一下|搜一下|找一下|检索一下|查询一下|搜索一下|查找一下|检索|搜索|查找|查询).{2,}/.test(compact)
  if (explicitGenericSearch) return true

  // Some public facts are defined by a periodically replaced official
  // document. Users reasonably expect the current version even when they omit
  // the word "latest".
  return /(?:法考|公考|国考|省考|公务员).{0,12}(?:政策|公告|通知|考纲|大纲|报名条件|报名时间|考试时间|考察要素|考查要素|考察内容|考查内容)|(?:政策|公告|通知|考纲|大纲|报名条件|报名时间|考试时间|考察要素|考查要素|考察内容|考查内容).{0,12}(?:法考|公考|国考|省考|公务员)/.test(compact)
}

/**
 * Turn routing may prepend an earlier substantive request and append control
 * sections such as "后续要求" / "当前追问". Those sections are useful to the
 * model but make poor search queries and have previously been sent verbatim to
 * providers. Keep the substantive anchor, remove runtime markup, and apply a
 * conservative length cap before deterministic runtime-prefetch.
 */
export function buildWebSearchQuery(prompt: string, maxChars = 240): string {
  const normalized = prompt
    .replace(/<knowledge_context>[\s\S]*?<\/knowledge_context>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r\n?/g, '\n')
  const anchor = normalized.split(/\n\s*(?:后续要求|当前追问)\s*[：:]/)[0] ?? ''
  const cleaned = anchor
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:后续要求|当前追问|runtime|system|assistant)\s*[：:]/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const fallback = normalized.replace(/\s+/g, ' ').trim()
  const query = cleaned || fallback
  if (query.length <= maxChars) return query
  const clipped = query.slice(0, Math.max(1, maxChars))
  const sentenceEnd = Math.max(
    clipped.lastIndexOf('。'),
    clipped.lastIndexOf('；'),
    clipped.lastIndexOf('？'),
    clipped.lastIndexOf('?')
  )
  return (sentenceEnd >= Math.floor(maxChars / 2)
    ? clipped.slice(0, sentenceEnd + 1)
    : clipped).trim()
}

export function factVerificationContract(
  prompt: string,
  options?: { primaryLegalSource?: LegalResearchPrimarySource }
): FactVerificationContract {
  if (
    prompt.includes('<inline_document_response>') ||
    isLegalResearchWorkflowPrompt(prompt)
  ) {
    return {
      required: false,
      requiresWebEvidence: false,
      requiresLegalEvidence: false,
      minimumFetchedSources: 0,
      minimumClaims: 1
    }
  }
  const compact = prompt.replace(/\s+/g, '')
  const required = /(?:核实|核验|查证|验证|辨别|判断).{0,20}(?:事实|真实性|准确性|真伪|真假|来源|新闻|规范|政策|数据)|(?:真实性|准确性|真伪|真假).{0,20}(?:核实|核验|查证|验证|判断)/s.test(compact)
  // 配置了法律主源（元典/北大法宝）时，法律规范/案例的核验由该 MCP 直接给出、
  // 内容可信，不再强制 web 交叉核验；普通事实/文书忠实性核验仍保留。
  const primaryLegalConfigured = options?.primaryLegalSource !== undefined
  const requiresLegalEvidence = !primaryLegalConfigured && required && /(?:规范|法律|法规|规章|司法解释|政策|条文|效力|现行有效)/.test(compact)
  const requiresWebEvidence = required && (
    /(?:事实|新闻|事件|数据|真实性|准确性|来源)/.test(compact) || !requiresLegalEvidence
  )
  const requestedClaims = Number.parseInt(
    compact.match(/(?:至少|不少于|核实|核验|查证)\s*(\d+)\s*(?:项|个|条)/)?.[1] ?? '0',
    10
  )
  const broadDocumentAudit = required && /(?:里面|其中|文档|论文|全文|文中|稿件|材料)/.test(compact)
  return {
    required,
    requiresWebEvidence,
    requiresLegalEvidence,
    minimumFetchedSources: requiresWebEvidence ? (broadDocumentAudit ? 3 : 2) : 0,
    minimumClaims: Math.min(Math.max(requestedClaims || (broadDocumentAudit ? 5 : 1), 1), 50)
  }
}

export function factVerificationInstruction(
  contract: FactVerificationContract,
  progress: FactVerificationProgress
): string | undefined {
  if (!contract.required) return undefined
  return [
    '<fact_verification_advisory>',
    `本任务包含事实核验需求。建议读取 ${contract.minimumFetchedSources} 个不同网页来源；法律规范权威来源：${contract.requiresLegalEvidence ? '优先取得' : '按需取得'}。`,
    `当前已读取网页来源 ${progress.fetchedSourceUrls.size} 个，法律来源${progress.legalEvidenceSatisfied ? '已取得' : '未取得'}，核验账本${progress.finalized ? '已通过' : '未通过'}。`,
    '- 尽可能先识别原文中的具体可核实陈述，再逐项给出 verified / contradicted / mixed / unverified 结论。',
    '- 优先使用 `web_search` 返回的 snippet 与 URL 作为引用来源；若 snippet 仅有标题、无实质内容（无法据此核实），应对关键来源调用 `web_fetch` 读取正文；不要为每个搜索结果逐个 fetch。',
    '- 规范、政策和法律文本必须核对名称、条文、发布机关、发布日期及效力状态。',
    `- 如来源足够，可调用 ${FACT_VERIFICATION_FINALIZE_TOOL_NAME} 整理核验账本；其中 URL 只能来自本轮实际读取的来源。`,
    '- 最终回答按“原陈述—结论—核验理由—来源—未决事项”展示，不得把未核实内容写成已确认事实。',
    '- 工具不可用、来源不足或账本未完成时，明确标注局限并继续输出可交付结果，不得仅输出阻塞说明。',
    '</fact_verification_advisory>'
  ].join('\n')
}

export function factVerificationProgress(
  items: readonly TurnItem[],
  turnId: string,
  contract: FactVerificationContract
): FactVerificationProgress {
  let webSearchAttempts = 0
  let webSearchSatisfied = false
  let webFetchAttempts = 0
  let legalSearchAttempts = 0
  let legalEvidenceSatisfied = false
  let finalized = false
  let finalizedClaimCount = 0
  let finalizeAttempts = 0
  const fetchedSourceUrls = new Set<string>()
  const legalSourceUrls = new Set<string>()

  for (const item of items) {
    if (item.turnId !== turnId || item.kind !== 'tool_result') continue
    if (item.toolName === 'web_search') {
      webSearchAttempts += 1
      if (item.isError !== true && countArrayField(item.output, 'results') > 0) webSearchSatisfied = true
      continue
    }
    if (item.toolName === 'web_fetch') {
      webFetchAttempts += 1
      if (item.isError !== true && meaningfulTextField(item.output, 'text')) {
        for (const url of urlsIn(item.output)) fetchedSourceUrls.add(url)
      }
      continue
    }
    if (item.toolName === 'knowledge_legal_external_sources') {
      legalSearchAttempts += 1
      if (item.isError !== true && meaningfulLegalEvidence(item.output)) {
        legalEvidenceSatisfied = true
        for (const url of urlsIn(item.output)) legalSourceUrls.add(url)
      }
      continue
    }
    if (item.toolName === FACT_VERIFICATION_FINALIZE_TOOL_NAME && item.isError !== true) {
      finalizeAttempts += 1
      const output = record(item.output)
      if (output.verificationPassed === true) {
        finalized = true
        finalizedClaimCount = typeof output.claimCount === 'number' ? output.claimCount : 0
      }
    } else if (item.toolName === FACT_VERIFICATION_FINALIZE_TOOL_NAME) {
      finalizeAttempts += 1
    }
  }

  return {
    webSearchAttempts,
    webSearchSatisfied,
    webFetchAttempts,
    fetchedSourceUrls,
    legalSearchAttempts,
    legalSourceUrls,
    legalEvidenceSatisfied,
    finalizeAttempts,
    finalized: finalized && finalizedClaimCount >= contract.minimumClaims,
    finalizedClaimCount
  }
}

export function validateFactVerificationLedger(
  args: Record<string, unknown>,
  options: {
    minimumClaims?: number
    minimumSources?: number
    allowedSourceUrls?: ReadonlySet<string>
  } = {}
): { ok: true; claims: Array<Record<string, unknown>>; sourceUrls: string[] } | { ok: false; error: string } {
  const claims = Array.isArray(args.claims)
    ? args.claims.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)))
    : []
  const minimumClaims = Math.max(1, options.minimumClaims ?? 1)
  if (claims.length < minimumClaims) {
    return { ok: false, error: `事实核验账本仅有 ${claims.length} 项，至少需要 ${minimumClaims} 项。` }
  }
  const sourceUrls = new Set<string>()
  const verdicts = new Set(['verified', 'contradicted', 'mixed', 'unverified'])
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index] ?? {}
    const statement = typeof claim.statement === 'string' ? claim.statement.trim() : ''
    const verdict = typeof claim.verdict === 'string' ? claim.verdict.trim().toLowerCase() : ''
    const rationale = typeof claim.rationale === 'string' ? claim.rationale.trim() : ''
    const evidence = Array.isArray(claim.evidence) ? claim.evidence : []
    if (statement.length < 4) return { ok: false, error: `第 ${index + 1} 项缺少明确的待核实陈述。` }
    if (!verdicts.has(verdict)) return { ok: false, error: `第 ${index + 1} 项 verdict 无效。` }
    if (rationale.length < 10) return { ok: false, error: `第 ${index + 1} 项缺少核验理由。` }
    if (verdict !== 'unverified' && evidence.length === 0) {
      return { ok: false, error: `第 ${index + 1} 项作出 ${verdict} 结论但没有来源证据。` }
    }
    for (const rawEvidence of evidence) {
      const entry = record(rawEvidence)
      const url = normalizeHttpUrl(entry.url)
      const title = typeof entry.title === 'string' ? entry.title.trim() : ''
      if (!url || !title) return { ok: false, error: `第 ${index + 1} 项含有缺少标题或有效 URL 的证据。` }
      if (options.allowedSourceUrls && !options.allowedSourceUrls.has(url)) {
        return { ok: false, error: `第 ${index + 1} 项引用了未实际读取的来源：${url}` }
      }
      sourceUrls.add(url)
    }
  }
  const minimumSources = Math.max(0, options.minimumSources ?? 0)
  if (sourceUrls.size < minimumSources) {
    return { ok: false, error: `事实核验账本仅引用 ${sourceUrls.size} 个已读取来源，至少需要 ${minimumSources} 个。` }
  }
  return { ok: true, claims, sourceUrls: [...sourceUrls] }
}

export function normalizedEvidenceUrls(progress: FactVerificationProgress): Set<string> {
  return new Set([...progress.fetchedSourceUrls, ...progress.legalSourceUrls])
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function countArrayField(value: unknown, key: string): number {
  const field = record(value)[key]
  return Array.isArray(field) ? field.length : 0
}

function meaningfulTextField(value: unknown, key: string): boolean {
  const field = record(value)[key]
  return typeof field === 'string' && field.replace(/\s+/g, '').length >= 40
}

function meaningfulLegalEvidence(value: unknown): boolean {
  const records = record(value).records
  if (!Array.isArray(records) || records.length === 0) return false
  return records.some((rawRecord) => {
    const legalRecord = record(rawRecord)
    const path = normalizeHttpUrl(legalRecord.path)
    const excerpt = typeof legalRecord.excerpt === 'string' ? legalRecord.excerpt : ''
    const title = typeof legalRecord.title === 'string' ? legalRecord.title.trim() : ''
    return Boolean(path && title && excerpt.replace(/\s+/g, '').length >= 40)
  })
}

function urlsIn(value: unknown, depth = 0): Set<string> {
  const urls = new Set<string>()
  if (depth > 8 || value == null) return urls
  if (typeof value === 'string') {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>\])}，。；;]+/gi)) {
      const normalized = normalizeHttpUrl(match[0])
      if (normalized) urls.add(normalized)
    }
    return urls
  }
  if (Array.isArray(value)) {
    for (const entry of value) for (const url of urlsIn(entry, depth + 1)) urls.add(url)
    return urls
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      for (const url of urlsIn(entry, depth + 1)) urls.add(url)
    }
  }
  return urls
}

export function normalizeHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    url.hash = ''
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
    return url.href
  } catch {
    return ''
  }
}
