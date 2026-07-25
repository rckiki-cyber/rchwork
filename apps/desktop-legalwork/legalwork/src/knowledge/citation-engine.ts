/**
 * Citation Engine — GB/T 7714-2015 信息与文献参考文献著录规则
 *
 * Provides citation formatting, source type detection, and bibliography generation
 * for academic paper writing. All functions are pure and stateless.
 */

export type CitationStyle = 'gbt7714' | 'plain'

export type SourceType =
  | 'journal_article'   // 期刊论文 [J]
  | 'book'              // 专著 [M]
  | 'legal_statute'     // 法规 [Z]
  | 'legal_case'        // 司法案例 [Z]
  | 'conference_paper'  // 会议论文 [C]
  | 'thesis'            // 学位论文 [D]
  | 'web_resource'      // 网页/网络资源 [EB/OL]
  | 'legal_interpretation' // 司法解释 [Z]
  | 'standard'          // 标准 [S]
  | 'other'             // 其他

export type CitationFields = {
  /** Authors, each in "姓 名" format */
  authors?: string[]
  /** Document title */
  title: string
  /** Source type for type identifier */
  sourceType: SourceType
  // Journal fields
  journalName?: string
  year?: number
  volume?: string
  issue?: string
  pages?: string
  // Book fields
  publisher?: string
  place?: string
  edition?: string
  // Statute fields
  lawName?: string
  articleNumber?: string
  validityStatus?: string
  promulgationDate?: string
  // Case fields
  caseNumber?: string
  court?: string
  judgmentDate?: string
  // Thesis fields
  degree?: string
  institution?: string
  // Web fields
  url?: string
  accessDate?: string
  // DOI
  doi?: string
}

/**
 * GB/T 7714 document type identifiers.
 */
const TYPE_MARKERS: Record<SourceType, string> = {
  journal_article: 'J',
  book: 'M',
  legal_statute: 'Z',
  legal_case: 'Z',
  conference_paper: 'C',
  thesis: 'D',
  web_resource: 'EB/OL',
  legal_interpretation: 'Z',
  standard: 'S',
  other: 'Z'
}

/**
 * Format a single citation in GB/T 7714-2015 style.
 */
export function formatGbt7714(fields: CitationFields, index?: number): string {
  const prefix = index !== undefined ? `[${index}] ` : ''
  const typeMarker = TYPE_MARKERS[fields.sourceType]

  switch (fields.sourceType) {
    case 'journal_article':
      return `${prefix}${formatAuthors(fields.authors)}${fields.title}[J]. ${fields.journalName ?? ''}, ${fields.year ?? ''}${fields.issue ? `(${fields.issue})` : ''}: ${formatPages(fields.pages)}.`

    case 'book':
      return `${prefix}${formatAuthors(fields.authors)}${fields.title}[M]. ${fields.edition ? `${fields.edition}版. ` : ''}${fields.place ? `${fields.place}: ` : ''}${fields.publisher ?? ''}, ${fields.year ?? ''}: ${formatPages(fields.pages)}.`

    case 'thesis':
      return `${prefix}${formatAuthors(fields.authors)}${fields.title}[D]. ${fields.place ?? ''}: ${fields.institution ?? ''}, ${fields.year ?? ''}.`

    case 'legal_statute':
      return `${prefix}${fields.lawName ?? fields.title}[Z]. ${fields.promulgationDate ? `${fields.promulgationDate}: ` : ''}${fields.articleNumber ?? ''}.`

    case 'legal_case':
      return `${prefix}${fields.court ?? ''}. ${fields.caseNumber ?? ''}${fields.title ? ` ${fields.title}` : ''}[Z]. ${fields.judgmentDate ?? ''}.`

    case 'legal_interpretation':
      return `${prefix}${fields.title}[Z]. ${fields.promulgationDate ?? ''}.`

    case 'conference_paper':
      return `${prefix}${formatAuthors(fields.authors)}${fields.title}[C]. ${fields.place ?? ''}: ${fields.publisher ?? ''}, ${fields.year ?? ''}.`

    case 'web_resource':
      return `${prefix}${formatAuthors(fields.authors)}${fields.title}[EB/OL]. ${fields.url ?? ''}, ${fields.accessDate ?? fields.year?.toString() ?? ''}.`

    case 'standard':
      return `${prefix}${fields.title}[S]. ${fields.place ?? ''}: ${fields.publisher ?? ''}, ${fields.year ?? ''}.`

    case 'other':
    default:
      return `${prefix}${formatAuthors(fields.authors)}${fields.title}[Z]. ${fields.place ?? ''}: ${fields.publisher ?? ''}, ${fields.year ?? ''}.`
  }
}

/**
 * Format a list of author names in GB/T 7714 style.
 * Multiple authors separated by commas (no "and").
 */
function formatAuthors(authors?: string[]): string {
  if (!authors || authors.length === 0) return ''
  return `${authors.join(', ')}. `
}

/**
 * Format page numbers.
 */
function formatPages(pages?: string): string {
  if (!pages) return ''
  // GB/T 7714 uses "-" as page range separator
  return pages
}

const SOURCE_TYPE_EXTENSION_MAP: Array<{
  extensions: string[]
  type: SourceType
}> = [
  { extensions: ['.md', '.markdown', '.txt'], type: 'other' },
  { extensions: ['.pdf'], type: 'journal_article' },
]

const SOURCE_TYPE_CATEGORY_MAP: Record<string, SourceType> = {
  '论文': 'journal_article',
  '案例判例': 'legal_case',
  '法规规范': 'legal_statute',
  '调研报告': 'other',
  '会议记录': 'conference_paper',
  '模板范本': 'other'
}

/**
 * Detect source type from KB document metadata, path, and content classification.
 */
export function detectSourceType(
  meta: { category?: string; tags?: string[]; source?: string },
  relativePath: string,
  category?: string
): SourceType {
  // Check type-specific tags first
  if (meta.tags) {
    if (meta.tags.some((t) => /法规|法条|法律|条例|办法|规定|施行/i.test(t))) return 'legal_statute'
    if (meta.tags.some((t) => /案例|判决|裁判|案号|法院|裁定/i.test(t))) return 'legal_case'
    if (meta.tags.some((t) => /期刊|学报|学术|论文|研究/i.test(t))) return 'journal_article'
    if (meta.tags.some((t) => /学位|博士|硕士|毕业论文/i.test(t))) return 'thesis'
    if (meta.tags.some((t) => /标准|国标|GB|ISO/i.test(t))) return 'standard'
  }

  // Check category
  const cat = category || meta.category
  if (cat && SOURCE_TYPE_CATEGORY_MAP[cat]) return SOURCE_TYPE_CATEGORY_MAP[cat]

  // Check extension
  const ext = relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase()
  for (const mapping of SOURCE_TYPE_EXTENSION_MAP) {
    if (mapping.extensions.includes(ext)) return mapping.type
  }

  return 'other'
}

/**
 * Build CitationFields from knowledge store metadata + document info.
 */
export function fieldsFromKnowledgeMeta(
  title: string,
  relativePath: string,
  meta: {
    source?: string
    author?: string
    category?: string
    tags?: string[]
    confidence?: string
  },
  category?: string,
  contentPreview?: string
): CitationFields {
  const sourceType = detectSourceType(meta, relativePath, category)
  const fields: CitationFields = { title, sourceType }

  // Extract author from meta
  if (meta.author) {
    fields.authors = [meta.author]
  }

  // Extract year from path or content
  const yearFromContent = extractYear(contentPreview)
  const yearFromPath = extractYear(relativePath)
  fields.year = yearFromContent ?? yearFromPath ?? undefined

  // Set source-type-specific fields
  if (sourceType === 'legal_statute') {
    fields.lawName = meta.source || title
  }
  if (sourceType === 'legal_case') {
    fields.court = meta.source || undefined
  }

  return fields
}

/**
 * Build a complete bibliography from an array of CitationFields.
 */
export function buildBibliography(
  entries: CitationFields[],
  style: CitationStyle = 'gbt7714'
): string {
  if (entries.length === 0) return ''

  const lines: string[] = ['## 参考文献', '']
  entries.forEach((entry, index) => {
    if (style === 'gbt7714') {
      lines.push(formatGbt7714(entry, index + 1))
    } else {
      lines.push(`${index + 1}. ${entry.title}`)
    }
  })
  lines.push('')
  return lines.join('\n')
}

// ── Helper extractors (lightweight regex, no NLP) ──────────

/**
 * Extract DOI from document content if present.
 * Pattern: "DOI: 10.xxxx/xxxx" or "https://doi.org/10.xxxx/xxxx"
 */
export function extractDoi(text: string): string | undefined {
  const match = text.match(
    /\b(?:doi|DOI)\s*[:：]\s*(10\.\d{4,}\/[^\s,;]{3,})|https:\/\/doi\.org\/(10\.\d{4,}\/[^\s,;]{3,})/
  )
  return match?.[1] ?? match?.[2] ?? undefined
}

/**
 * Extract publication year from document content or filename.
 * Looks for "20XX年" patterns or 4-digit years in context.
 */
export function extractYear(text?: string): number | undefined {
  if (!text) return undefined
  const match = text.match(/(?:20[0-9]{2})\s*年|\(20[0-9]{2}\)/)
  if (match) {
    const digits = match[0].match(/20[0-9]{2}/)
    if (digits) return Number.parseInt(digits[0], 10)
  }
  return undefined
}

/**
 * Extract journal name from text content.
 * Looks for patterns like "载《XXX》" or "XXX学报"
 */
export function extractJournal(text: string): string | undefined {
  const inBrackets = text.match(/载[《（]([^》）]+)[》）]/)
  if (inBrackets) return inBrackets[1]
  const journalMatch = text.match(/([^\s，。]{2,}(?:学报|研究|评论|月刊|季刊|周刊|期刊))/)
  if (journalMatch) return journalMatch[1]
  return undefined
}

/**
 * Extract author names from document content.
 * Looks for "作者：XXX" or "作者: XXX" patterns.
 */
export function extractAuthors(text: string): string[] {
  const match = text.match(/作者[：:]\s*([^\n]{1,60})/)
  if (match) {
    return match[1].split(/[,，、;；]/).map((a) => a.trim()).filter(Boolean).slice(0, 5)
  }
  return []
}

/**
 * Try to extract all metadata fields from a content/filename.
 * Used during knowledge base sync for heuristic enrichment.
 */
export function extractMetadataFromContent(
  content: string,
  filePath: string
): {
  doi?: string
  publicationYear?: number
  journal?: string
  authors: string[]
} {
  return {
    doi: extractDoi(content),
    publicationYear: extractYear(content) ?? extractYear(filePath) ?? undefined,
    journal: extractJournal(content),
    authors: extractAuthors(content)
  }
}
