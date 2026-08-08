import { readFileSync, existsSync } from 'node:fs'
import type { KnowledgeStore } from '../knowledge/knowledge-store.js'
import type { KnowledgeSearchHit } from '../contracts/knowledge.js'
import type { KnowledgeContextRecord, KnowledgeRetrievalResult, KnowledgeLayer } from '../contracts/knowledge-retrieval.js'
import { KnowledgeMeta, DEFAULT_KNOWLEDGE_META } from '../contracts/knowledge-retrieval.js'
import { fieldsFromKnowledgeMeta, formatGbt7714, buildBibliography } from './citation-engine.js'
import { route, LAYER_LABEL } from './knowledge-pyramid-router.js'
import { buildKnowledgeRetrievalQueries } from './knowledge-query-planner.js'

const MAX_CONTEXT_CHARS = 8_000
const MAX_SOURCES = 12
const RRF_K = 60

/**
 * Auto-retrieval pipeline that, given a user query, automatically:
 * 1. Searches the local knowledge base for relevant content
 * 2. Checks metadata for expiry/deprecation status
 * 3. Formats a compact context block for model injection
 * 4. Returns source records for citation tracking
 */
export class KnowledgeRetrievalPipeline {
  constructor(private readonly store: KnowledgeStore) {}

  /**
   * Run the full retrieval pipeline for a user query.
   * Supports pyramid layer routing when `layer` is specified or auto-detected.
   * Returns formatted context text + source citations.
   */
  async retrieve(query: string, options?: {
    maxChars?: number
    excludeExpired?: boolean
    includeExternal?: boolean
    layer?: KnowledgeLayer
    layers?: KnowledgeLayer[]
    pathPrefix?: string
  }): Promise<KnowledgeRetrievalResult> {
    const startedAt = Date.now()
    const maxChars = options?.maxChars ?? MAX_CONTEXT_CHARS
    const excludeExpired = options?.excludeExpired ?? true

    // The L1-L5 pyramid is a software/engineering abstraction taxonomy. For
    // ordinary legal queries, auto-routing terms such as "如何" or "规范" can
    // point at the wrong engineering layer and suppress relevant labelled
    // documents. Explicit layer selections are still respected; legal queries
    // simply default to all layers.
    const routeResult = route(query)
    const autoLayers = isLegalQuery(query) ? [] : routeResult.targetLayers
    const targetLayers = options?.layers ?? (options?.layer ? [options.layer] : undefined) ?? autoLayers

    // 1. Search local knowledge base. Short questions use one query; long task
    // prompts get one additional focused query that removes output-format/task
    // scaffolding. Results are fused with deterministic reciprocal-rank fusion,
    // improving recall without spending model tokens on query rewriting.
    const retrievalQueries = buildKnowledgeRetrievalQueries(query)
    const hitGroups: KnowledgeSearchHit[][] = []
    for (const retrievalQuery of retrievalQueries) {
      hitGroups.push(await this.store.search({
        query: retrievalQuery,
        limit: MAX_SOURCES,
        includeContent: true,
        ...(options?.pathPrefix ? { pathPrefix: options.pathPrefix } : {}),
        ...(targetLayers.length > 0 ? { layers: targetLayers } : {})
      }))
    }
    const hits = fuseKnowledgeHits(hitGroups).slice(0, MAX_SOURCES)

    // 2. Filter by expiry and deprecation if requested
    const filtered = excludeExpired
      ? await this.filterExpired(hits.map((h) => h.path))
      : new Set<string>()

    // 3. Build context records with metadata enrichment
    const records: KnowledgeContextRecord[] = []
    const contextEntries: string[] = []
    let totalChars = 0
    const bibliographyEntries: Array<{ title: string; citation: string }> = []

    for (const hit of hits) {
      if (filtered.has(hit.path)) continue

      // Read sidecar .meta.json if available
      const meta = this.readMetadata(hit.path)
      const citation = this.buildCitationWithMeta(hit.title, hit.relativePath, meta)
      const confidenceTag = meta.confidence === 'high' ? 'high_confidence' : meta.confidence === 'deprecated' ? 'deprecated' : ''
      const tags = [...meta.tags]
      if (meta.deprecated) tags.push('deprecated')
      if (meta.expiresAt) tags.push('has_expiry')
      if (confidenceTag) tags.push(confidenceTag)

      // Build GB/T 7714 citation from metadata
      const citationFields = fieldsFromKnowledgeMeta(
        hit.title,
        hit.relativePath,
        { source: meta.source, author: meta.author, category: meta.category, tags: meta.tags, confidence: meta.confidence },
        hit.category,
        hit.content
      )
      const gbt7714Citation = formatGbt7714(citationFields)

      const record: KnowledgeContextRecord = {
        path: hit.relativePath,
        title: hit.title,
        relevanceScore: Math.min(1, hit.score / 30),
        excerpt: hit.snippet,
        content: hit.content,
        citation,
        tags,
        sourceKind: 'local',
        gbt7714Citation,
        authors: citationFields.authors ?? [],
        publicationYear: citationFields.year,
        publicationName: citationFields.journalName,
        doi: citationFields.doi,
        layer: hit.layer
      }

      // Only expose a source to callers/model if its excerpt actually fits in
      // the context block. This prevents "source metadata without evidence"
      // and keeps citation lists aligned with the text the model can inspect.
      const entry = this.formatEntry(record)
      if (totalChars + entry.length <= maxChars) {
        records.push(record)
        bibliographyEntries.push({ title: hit.title, citation: gbt7714Citation })
        contextEntries.push(entry)
        totalChars += entry.length
      }
    }

    // 4. Format the final context text
    const contextText = this.formatContextText(contextEntries, routeResult, targetLayers.length > 0)
    const bibliography = buildBibliography(
      bibliographyEntries.map((e) => {
        // Parse citation back from stored format
        const fields = fieldsFromKnowledgeMeta(e.title, e.title, { source: '', author: '', category: '', tags: [], confidence: 'medium' })
        return fields
      })
    )

    return {
      contextText,
      sources: records,
      consultedExternal: false,
      latencyMs: Date.now() - startedAt,
      bibliography,
      citations: bibliographyEntries.map((e) => e.citation)
    }
  }

  /**
   * Read sidecar metadata file if present.
   */
  private readMetadata(filePath: string): KnowledgeMeta {
    // Derive .meta.json path from the document path
    // KnowledgeStore stores absolute paths, so we look for .meta.json alongside
    const metaPath = filePath.replace(/\.\w+$/, '.meta.json')
    if (existsSync(metaPath)) {
      try {
        const raw = readFileSync(metaPath, 'utf8')
        const parsed = JSON.parse(raw)
        const result = KnowledgeMeta.safeParse(parsed)
        if (result.success) return result.data
      } catch {
        // Fall through to default
      }
    }
    return { ...DEFAULT_KNOWLEDGE_META }
  }

  /**
   * Build a citation string enriched with metadata info.
   */
  private buildCitationWithMeta(title: string, relativePath: string, meta: KnowledgeMeta): string {
    const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
    const folder = parts.slice(0, -1).join(' › ')
    const fileName = parts.at(-1)?.replace(/\.[^/.]+$/, '') ?? title
    const base = folder ? `${folder} › ${fileName}` : fileName
    if (meta.category) {
      return `[${meta.category}] ${base}`
    }
    return base
  }

  /**
   * Format a single entry for the context block.
   */
  private formatEntry(record: KnowledgeContextRecord): string {
    const badges: string[] = []
    if (record.layer) badges.push(LAYER_LABEL[record.layer])
    if (record.tags.includes('has_expiry')) badges.push('⚠️ 有时效性')
    if (record.tags.includes('deprecated')) badges.push('⚠️ 已废弃')
    if (record.tags.includes('high_confidence')) badges.push('可信度高')
    if (record.tags.includes('经验分享')) badges.push('经验分享')
    const badgeStr = badges.length ? ` [${badges.join('][')}]` : ''
    return `[${record.citation}]${badgeStr}\n${record.excerpt.slice(0, 600)}\n\n`
  }

  /**
   * Format context records into a compact block for model injection. The user
   * query already exists in the preceding tool call/history, so repeating it in
   * the tool result only creates new miss tokens.
   */
  private formatContextText(
    entries: string[],
    routeResult: { primaryLayer?: string; primaryLabel?: string },
    layerFilterApplied: boolean
  ): string {
    if (!entries.length) return ''

    let header = `【知识库检索结果】\n匹配 ${entries.length} 个来源`
    if (layerFilterApplied && routeResult.primaryLabel) {
      header += `\n主要检索层级：${routeResult.primaryLabel}`
    }
    header += '\n\n'
    return header + entries.join('\n\n')
  }

  /**
   * Check which documents are expired/deprecated using sidecar metadata.
   */
  private async filterExpired(filePaths: string[]): Promise<Set<string>> {
    const expired = new Set<string>()
    const now = Date.now()
    for (const filePath of filePaths) {
      const meta = this.readMetadata(filePath)
      if (meta.deprecated) {
        expired.add(filePath)
        continue
      }
      if (meta.expiresAt) {
        try {
          const expiresAt = new Date(meta.expiresAt).getTime()
          if (now > expiresAt) {
            expired.add(filePath)
          }
        } catch {
          // Invalid date string, skip
        }
      }
    }
    return expired
  }
}

function fuseKnowledgeHits(groups: KnowledgeSearchHit[][]): KnowledgeSearchHit[] {
  if (groups.length <= 1) return groups[0] ?? []

  const fused = new Map<string, {
    hit: KnowledgeSearchHit
    rrf: number
    appearances: number
    bestRank: number
  }>()

  for (const group of groups) {
    group.forEach((hit, index) => {
      const key = hit.relativePath || hit.documentId
      const contribution = 1 / (RRF_K + index + 1)
      const existing = fused.get(key)
      if (!existing) {
        fused.set(key, {
          hit,
          rrf: contribution,
          appearances: 1,
          bestRank: index
        })
        return
      }
      existing.rrf += contribution
      existing.appearances += 1
      existing.bestRank = Math.min(existing.bestRank, index)
      if (hit.score > existing.hit.score) existing.hit = hit
    })
  }

  return [...fused.values()]
    .sort((left, right) =>
      right.rrf - left.rrf ||
      right.appearances - left.appearances ||
      left.bestRank - right.bestRank ||
      right.hit.score - left.hit.score ||
      left.hit.relativePath.localeCompare(right.hit.relativePath)
    )
    .map((entry) => entry.hit)
}

/** Detect if a query likely relates to legal/time-sensitive information. */
export function isLegalQuery(query: string): boolean {
  const legalTerms = [
    '法', '法规', '条例', '规定', '办法', '通知', '公告',
    '合同', '协议', '条款', '违约', '责任', '赔偿',
    '诉讼', '仲裁', '判决', '裁定', '案例',
    '合规', '尽调', '审查',
    '民法典', '公司法', '劳动法', '刑法', '行政',
    '最高法', '最高检', '司法',
    '废止', '失效', '修改',
    '裁判', '要旨', '规则'
  ]
  const lower = query.toLowerCase()
  return legalTerms.some((term) => lower.includes(term))
}
