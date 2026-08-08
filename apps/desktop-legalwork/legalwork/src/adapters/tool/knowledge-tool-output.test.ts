import { describe, expect, it } from 'vitest'
import type { KnowledgeSearchHit } from '../../contracts/knowledge.js'
import type { KnowledgeRetrievalResult } from '../../contracts/knowledge-retrieval.js'
import {
  KNOWLEDGE_AUTO_MAX_SOURCES,
  KNOWLEDGE_SEARCH_MAX_SOURCES,
  KNOWLEDGE_TOOL_MAX_SERIALIZED_CHARS,
  compactKnowledgeAutoRetrieveToolOutput,
  compactKnowledgeSearchToolOutput,
  compactKnowledgeTreeToolOutput
} from './knowledge-tool-output.js'

function searchHit(index: number): KnowledgeSearchHit {
  return {
    documentId: `doc-${index}`,
    chunkId: `chunk-${index}`,
    title: `行政法论文 ${index}`,
    path: `/tmp/knowledge/论文-${index}.md`,
    relativePath: `论文/行政法论文-${index}.md`,
    category: '论文',
    tags: ['行政法', '人工智能'],
    keywords: ['自动化行政', '正当程序'],
    score: 20 - index,
    rankReason: 'phrase+coverage',
    snippet: `摘要${index}: ${'检索片段'.repeat(220)}`,
    content: `完整内容${index}: ${'正文'.repeat(2_000)}`,
    layer: 'architecture'
  }
}

function retrievalResult(): KnowledgeRetrievalResult {
  return {
    contextText: `【知识库检索结果】\n${'行政法人工智能交叉研究资料。'.repeat(1_000)}`,
    sources: Array.from({ length: 10 }, (_, index) => ({
      path: `论文/行政法论文-${index}.md`,
      title: `行政法论文 ${index}`,
      relevanceScore: 0.9,
      excerpt: `摘要${index}: ${'重复摘录'.repeat(500)}`,
      content: `完整内容${index}: ${'正文'.repeat(2_000)}`,
      citation: `[论文] 行政法论文 ${index}`,
      tags: ['行政法', '人工智能'],
      sourceKind: 'local' as const,
      gbt7714Citation: `作者${index}. 行政法论文 ${index}[J]. 法学研究, 2026.`,
      authors: [`作者${index}`],
      publicationYear: 2026,
      publicationName: '法学研究',
      layer: 'architecture' as const
    })),
    consultedExternal: false,
    latencyMs: 12,
    bibliography: '参考文献\n' + '重复书目信息'.repeat(1_000),
    citations: Array.from({ length: 10 }, (_, index) => `作者${index}. 行政法论文 ${index}[J]. 法学研究, 2026.`)
  }
}

describe('knowledge tool output budgets', () => {
  it('returns compact search snippets without duplicating full chunk content', () => {
    const output = compactKnowledgeSearchToolOutput({
      query: '人工智能 行政法',
      layer: 'all',
      sources: Array.from({ length: 9 }, (_, index) => searchHit(index))
    })

    expect(output.sources).toHaveLength(KNOWLEDGE_SEARCH_MAX_SOURCES)
    expect(output._meta.originalSourceCount).toBe(9)
    expect(output._meta.truncated).toBe(true)
    for (const source of output.sources) {
      expect(source).not.toHaveProperty('content')
      expect(source).not.toHaveProperty('path')
      expect(String(source.snippet).length).toBeLessThanOrEqual(500)
    }
  })

  it('returns one model-facing source when several chunks belong to the same file', () => {
    const first = searchHit(1)
    const output = compactKnowledgeSearchToolOutput({
      query: '人工智能 行政法',
      layer: 'all',
      sources: [first, { ...first, chunkId: 'chunk-1-second', snippet: '第二个命中块' }]
    })

    expect(output.sources).toHaveLength(1)
    expect(output._meta).toMatchObject({ originalSourceCount: 2, returnedSourceCount: 1, truncated: true })
  })

  it('deduplicates auto-retrieval evidence and enforces a total serialized budget', () => {
    const output = compactKnowledgeAutoRetrieveToolOutput(retrievalResult())
    const serialized = JSON.stringify(output)

    expect(output.sources).toHaveLength(KNOWLEDGE_AUTO_MAX_SOURCES)
    expect(serialized.length).toBeLessThanOrEqual(KNOWLEDGE_TOOL_MAX_SERIALIZED_CHARS)
    expect(output._meta.originalSourceCount).toBe(10)
    expect(output._meta.truncated).toBe(true)
    expect(output.contextText.length).toBeLessThanOrEqual(5_000)
    expect(output).not.toHaveProperty('bibliography')
    for (const source of output.sources) {
      expect(source).not.toHaveProperty('content')
      expect(source).not.toHaveProperty('excerpt')
      expect(source).toHaveProperty('gbt7714Citation')
    }
  })

  it('paginates tree output and omits recursive children', () => {
    const output = compactKnowledgeTreeToolOutput(Array.from({ length: 100 }, (_, index) => ({
      name: `目录${index}`,
      path: `目录${index}`,
      kind: 'folder' as const,
      children: [{ name: '内部文件.md', path: `目录${index}/内部文件.md`, kind: 'file' as const }]
    })), 10, 5)

    expect(output).toMatchObject({ total: 100, offset: 10, returned: 5, truncated: true, nextOffset: 15 })
    expect(output.nodes[0]).toMatchObject({ name: '目录10', childCount: 1 })
    expect(output.nodes[0]).not.toHaveProperty('children')
  })
})
