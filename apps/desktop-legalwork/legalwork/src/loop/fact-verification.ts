import type { TurnItem } from '../contracts/items.js'

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

export function factVerificationContract(prompt: string): FactVerificationContract {
  const compact = prompt.replace(/\s+/g, '')
  const required = /(?:核实|核验|查证|验证|辨别|判断).{0,20}(?:事实|真实性|准确性|真伪|真假|来源|新闻|规范|政策|数据)|(?:真实性|准确性|真伪|真假).{0,20}(?:核实|核验|查证|验证|判断)/s.test(compact)
  const requiresLegalEvidence = required && /(?:规范|法律|法规|规章|司法解释|政策|条文|效力|现行有效)/.test(compact)
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
    '<fact_verification_contract>',
    `本任务是事实核验任务。网页正文要求：${contract.minimumFetchedSources} 个不同来源；法律规范权威来源：${contract.requiresLegalEvidence ? '必需' : '非必需'}。`,
    `当前已读取网页来源 ${progress.fetchedSourceUrls.size} 个，法律来源${progress.legalEvidenceSatisfied ? '已取得' : '未取得'}，核验账本${progress.finalized ? '已通过' : '未通过'}。`,
    '- 必须先识别原文中的具体可核实陈述，再逐项给出 verified / contradicted / mixed / unverified 结论。',
    '- 搜索结果摘要不能直接作为最终证据；网页类来源必须实际调用 web_fetch 读取正文。',
    '- 规范、政策和法律文本必须核对名称、条文、发布机关、发布日期及效力状态。',
    `- 研究完成后必须调用 ${FACT_VERIFICATION_FINALIZE_TOOL_NAME}；其中 URL 只能来自本轮实际读取的来源。`,
    '- 最终回答按“原陈述—结论—核验理由—来源—未决事项”展示，不得把未核实内容写成已确认事实。',
    '</fact_verification_contract>'
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
