/**
 * Citation Verifier — 论文引文核验器
 *
 * Takes a completed paper draft and the knowledge base index snapshot,
 * cross-references every citation marker against stored documents to
 * detect fabricated or misattributed citations.
 *
 * All functions are pure and stateless — no I/O, no side effects.
 * The verifier works on the KB index in memory (documents + chunks arrays).
 */

import type { KnowledgeDocument, KnowledgeChunk } from '../contracts/knowledge.js'

export interface CitationLocation {
  /** Raw citation text as found in the draft, e.g. "[1]", "[2,3]", "[1-3]" */
  rawText: string
  /** 1-indexed line number */
  line: number
  /** 0-indexed column */
  column: number
  /** The sentence/context around the citation */
  context: string
}

export interface CitationCheck {
  /** The raw citation marker text */
  rawText: string
  /** Parsed citation index numbers */
  indices: number[]
  /** Position in the document */
  location: CitationLocation
  /** Classification result */
  status: 'verified' | 'not_found_in_kb' | 'content_mismatch' | 'page_number_suspicious' | 'doi_mismatch'
  /** The KB document matched, if any */
  matchedDocument?: {
    title: string
    relativePath: string
    score: number
  }
  /** Explanation of the check result */
  details: string
}

export interface CitationVerificationResult {
  documentStats: {
    totalCitations: number
    verified: number
    notFound: number
    contentMismatch: number
    suspicious: number
  }
  checks: CitationCheck[]
  recommendations: string[]
}

export interface CitationReferenceEntry {
  index: number
  text: string
  line: number
}

const CITATION_RE = /\[(\d+(?:\s*[-,]\s*\d+)*)\]/g

/**
 * Extract all citation markers from a draft text.
 * Supports: [1], [2,3], [1-3], [1,2,4-6]
 */
export function extractCitations(draft: string): CitationLocation[] {
  const locations: CitationLocation[] = []
  const lines = draft.split('\n')

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]
    let match: RegExpExecArray | null

    while ((match = CITATION_RE.exec(line)) !== null) {
      const col = match.index
      // Get surrounding context (50 chars before and after)
      const contextStart = Math.max(0, col - 50)
      const contextEnd = Math.min(line.length, col + match[0].length + 50)
      const context = (contextStart > 0 ? '...' : '') +
        line.slice(contextStart, contextEnd) +
        (contextEnd < line.length ? '...' : '')

      locations.push({
        rawText: match[0],
        line: lineIdx + 1,
        column: col,
        context
      })
    }
  }

  return locations
}

/**
 * Parse a citation marker text into individual index numbers.
 * "[1]" → [1], "[2,3]" → [2,3], "[1-3]" → [1,2,3]
 */
export function parseCitationIndices(rawText: string): number[] {
  const inner = rawText.replace(/[[\]]/g, '').trim()
  if (!inner) return []

  const parts = inner.split(/[,，]/).map((p) => p.trim()).filter(Boolean)
  const indices: Set<number> = new Set()

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*[-—]\s*(\d+)$/)
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10)
      const end = Number.parseInt(rangeMatch[2], 10)
      for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
        indices.add(i)
      }
    } else {
      const num = Number.parseInt(part, 10)
      if (!Number.isNaN(num)) indices.add(num)
    }
  }

  return [...indices].sort((a, b) => a - b)
}

/**
 * Extract numbered bibliography entries from the reference section. Numeric
 * markers such as [1] have no meaning without this mapping, so verification
 * must resolve them before searching the knowledge base.
 */
export function extractReferenceEntries(draft: string): CitationReferenceEntry[] {
  const lines = draft.split('\n')
  const headingIndex = bibliographyHeadingIndex(lines)
  const start = headingIndex >= 0 ? headingIndex + 1 : 0
  const entries: CitationReferenceEntry[] = []
  for (let lineIndex = start; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? ''
    const match = /^\s*(?:\[(\d+)\]|(\d+)[.、])\s+(.{2,})\s*$/.exec(line)
    if (!match) continue
    const index = Number.parseInt(match[1] ?? match[2] ?? '', 10)
    const text = (match[3] ?? '').trim()
    if (Number.isFinite(index) && index > 0 && text) {
      entries.push({ index, text, line: lineIndex + 1 })
    }
  }
  return entries
}

/**
 * Build a focused KB query from a bibliography entry. Searching the complete
 * GB/T 7714 line (authors, journal marker, volume, pages, and "待核" notes)
 * often dilutes the actual title and returns no document even when the PDF is
 * present. Prefer the title, then retain the full entry as a fallback.
 */
export function citationReferenceSearchQueries(referenceText: string): string[] {
  const cleaned = referenceText.trim()
  if (!cleaned) return []
  const withoutAuthors = cleaned.replace(/^.{1,120}?[.．]\s*/, '')
  const title = withoutAuthors
    .split(/\[[A-Z][^\]]*\]/i, 1)[0]
    ?.replace(/[（(](?:期刊|出版|卷期|页码)[^）)]*(?:待核|待查)[^）)]*[）)]/g, '')
    .replace(/[.。]\s*$/, '')
    .trim()
  return [...new Set([title, cleaned].filter((value): value is string => Boolean(value)))]
}

/**
 * Normalize a title for fuzzy matching: lowercase, remove punctuation, collapse whitespace.
 */
function normalizeTitle(title: string): string {
  return title
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Compute simple string similarity (0-1) using character bigram overlap.
 */
function bigramSimilarity(a: string, b: string): number {
  const normA = normalizeTitle(a)
  const normB = normalizeTitle(b)
  if (!normA || !normB) return 0
  if (normA === normB) return 1

  const bigramsA = new Set<string>()
  const bigramsB = new Set<string>()
  for (let i = 0; i < normA.length - 1; i++) bigramsA.add(normA.slice(i, i + 2))
  for (let i = 0; i < normB.length - 1; i++) bigramsB.add(normB.slice(i, i + 2))

  let intersection = 0
  for (const bigram of bigramsA) {
    if (bigramsB.has(bigram)) intersection++
  }

  const union = bigramsA.size + bigramsB.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * Try to match a citation to a KB document using multiple strategies.
 * Returns the best match above threshold or undefined.
 */
function matchCitationToDocument(
  citationText: string,
  documents: KnowledgeDocument[],
  chunks: KnowledgeChunk[],
): { title: string; relativePath: string; score: number } | undefined {
  // Strategy 1: Direct title match
  const cleanRef = citationText
    .replace(/^\s*(?:\[\d+(?:\s*[-,]\s*\d+)*\]|\d+[.、])\s*/, '')
    .trim()
  if (!cleanRef) return undefined
  const focusedReference = citationReferenceSearchQueries(cleanRef)[0] ?? cleanRef
  const normalizedReference = normalizeTitle(focusedReference)
  for (const doc of documents) {
    const normalizedDocumentTitle = normalizeTitle(doc.title)
    if (
      normalizedDocumentTitle.length >= 2 &&
      (normalizedReference.includes(normalizedDocumentTitle) ||
        (normalizedReference.length >= 4 && normalizedDocumentTitle.includes(normalizedReference)))
    ) {
      return { title: doc.title, relativePath: doc.relativePath, score: 0.95 }
    }
    const sim = bigramSimilarity(focusedReference, doc.title)
    if (sim >= 0.85) {
      return { title: doc.title, relativePath: doc.relativePath, score: sim }
    }
  }

  // Strategy 2: Match against chunk content titles
  for (const chunk of chunks) {
    const sim = bigramSimilarity(cleanRef, chunk.title)
    if (sim >= 0.85) {
      return { title: chunk.title, relativePath: chunk.relativePath, score: sim }
    }
  }

  // Strategy 3: Keywords from citation match document keywords
  const keywords = focusedReference.split(/\s+/).filter((k) => k.length >= 2)
  if (keywords.length > 0) {
    for (const doc of documents) {
      const docKeywords = (doc.keywords ?? []).join(' ')
      const matchCount = keywords.filter((kw) => docKeywords.toLocaleLowerCase().includes(kw.toLocaleLowerCase())).length
      if (matchCount >= Math.min(2, keywords.length)) {
        return { title: doc.title, relativePath: doc.relativePath, score: 0.5 }
      }
    }
  }

  return undefined
}

/**
 * Verify a single citation against the KB index.
 */
export function verifyCitation(
  citationText: string,
  documents: KnowledgeDocument[],
  chunks: KnowledgeChunk[],
  referenceText?: string,
): CitationCheck {
  const indices = parseCitationIndices(citationText)
  const candidateText = referenceText?.trim() || citationText
  const matched = matchCitationToDocument(candidateText, documents, chunks)

  if (!matched) {
    return {
      rawText: citationText,
      indices,
      location: { rawText: citationText, line: 0, column: 0, context: '' },
      status: 'not_found_in_kb',
      details: `引用 "${citationText}" 在知识库中未找到匹配的文档。可能是幻觉引用。建议删除或替换为知识库中可验证的来源。`
    }
  }

  if (matched.score < 0.7) {
    return {
      rawText: citationText,
      indices,
      location: { rawText: citationText, line: 0, column: 0, context: '' },
      status: 'content_mismatch',
      matchedDocument: matched,
      details: `引用 "${citationText}" 可能不精确匹配知识库中的 "${matched.title}"（相似度 ${(matched.score * 100).toFixed(0)}%）。请核对引用内容是否与源文件一致。`
    }
  }

  return {
    rawText: citationText,
    indices,
    location: { rawText: citationText, line: 0, column: 0, context: '' },
    status: 'verified',
    matchedDocument: matched,
    details: `已在知识库中验证：${matched.title}，路径：${matched.relativePath}。`
  }
}

/**
 * Run full verification on a paper draft against the KB index.
 *
 * @param draft The complete paper draft text containing citation markers
 * @param kbIndex Knowledge base index snapshot (documents + chunks arrays)
 * @returns Structured verification result
 */
export function verifyPaperCitations(
  draft: string,
  kbIndex: { documents: KnowledgeDocument[]; chunks: KnowledgeChunk[] },
): CitationVerificationResult {
  const referenceEntries = extractReferenceEntries(draft)
  const references = new Map(referenceEntries.map((entry) => [entry.index, entry.text]))
  const bibliographyLine = bibliographyStartLine(draft)
  const locations = extractCitations(draft).filter((location) => (
    bibliographyLine === 0 || location.line < bibliographyLine
  ))
  const seen = new Set<string>()
  const checks: CitationCheck[] = []

  for (const loc of locations) {
    // Deduplicate: skip if we already verified this exact raw text
    if (seen.has(loc.rawText)) continue
    seen.add(loc.rawText)

    const indices = parseCitationIndices(loc.rawText)
    const perReference = indices.map((index) => {
      const referenceText = references.get(index)
      if (!referenceText) {
        return {
          index,
          status: 'not_found_in_kb' as const,
          details: `参考文献列表中缺少 [${index}] 对应条目。`
        }
      }
      const verified = verifyCitation(loc.rawText, kbIndex.documents, kbIndex.chunks, referenceText)
      return {
        index,
        status: verified.status,
        details: verified.details,
        matchedDocument: verified.matchedDocument
      }
    })
    const failed = perReference.find((entry) => entry.status === 'not_found_in_kb')
      ?? perReference.find((entry) => entry.status === 'content_mismatch')
    const check: CitationCheck = {
      rawText: loc.rawText,
      indices,
      location: loc,
      status: failed?.status ?? 'verified',
      ...(perReference.find((entry) => entry.matchedDocument)?.matchedDocument
        ? { matchedDocument: perReference.find((entry) => entry.matchedDocument)?.matchedDocument }
        : {}),
      details: perReference.length > 0
        ? perReference.map((entry) => `[${entry.index}] ${entry.details}`).join(' ')
        : `引用 "${loc.rawText}" 不包含可识别的序号。`
    }
    checks.push(check)
  }

  // Build statistics
  const totalCitations = checks.length
  let verified = 0
  let notFound = 0
  let contentMismatch = 0
  let suspicious = 0

  for (const check of checks) {
    switch (check.status) {
      case 'verified': verified++; break
      case 'not_found_in_kb': notFound++; break
      case 'content_mismatch': contentMismatch++; break
      case 'page_number_suspicious':
      case 'doi_mismatch': suspicious++; break
    }
  }

  // Generate recommendations
  const recommendations: string[] = []
  if (notFound > 0) {
    recommendations.push(`发现 ${notFound} 条引用在知识库中无对应源文件。请删除或替换为可验证的来源。`)
  }
  if (contentMismatch > 0) {
    recommendations.push(`发现 ${contentMismatch} 条引用可能张冠李戴。请核对每条引用的实际内容与源文件是否一致。`)
  }
  if (verified > 0) {
    recommendations.push(`${verified} 条引用已通过知识库验证。`)
  }
  if (recommendations.length === 0) {
    recommendations.push('论文中没有发现需要核验的引用标记。')
  }

  return {
    documentStats: { totalCitations, verified, notFound, contentMismatch, suspicious },
    checks,
    recommendations
  }
}

function bibliographyHeadingIndex(lines: string[]): number {
  return lines.findIndex((line) => (
    /^\s*(?:#{1,6}\s*)?(?:参考文献|引用文献|主要参考资料)\s*[：:]?\s*$/.test(line)
  ))
}

function bibliographyStartLine(draft: string): number {
  const index = bibliographyHeadingIndex(draft.split('\n'))
  return index >= 0 ? index + 1 : 0
}
