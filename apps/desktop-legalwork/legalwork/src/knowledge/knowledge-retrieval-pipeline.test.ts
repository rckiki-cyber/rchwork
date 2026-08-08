import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeSearchHit } from '../contracts/knowledge.js'
import type { KnowledgeStore } from './knowledge-store.js'
import { KnowledgeRetrievalPipeline } from './knowledge-retrieval-pipeline.js'

function hit(input: {
  index: number
  title: string
  relativePath: string
  score?: number
  snippet?: string
}): KnowledgeSearchHit {
  return {
    documentId: `doc-${input.index}`,
    chunkId: `chunk-${input.index}`,
    title: input.title,
    path: `/tmp/${input.relativePath}`,
    relativePath: input.relativePath,
    category: '论文',
    tags: ['法律'],
    keywords: ['劳动合同'],
    score: input.score ?? 18,
    rankReason: '测试命中',
    snippet: input.snippet ?? `${input.title} 的核心检索片段`,
    content: `${input.title} 的完整正文`,
    layer: 'architecture'
  }
}

function fakeStore(searchImpl: KnowledgeStore['search']): KnowledgeStore {
  return {
    search: searchImpl,
    sync: vi.fn(),
    diagnostics: vi.fn(),
    setLastSelected: vi.fn(),
    tree: vi.fn(),
    createFolder: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    extractText: vi.fn(),
    absolutePath: vi.fn(),
    move: vi.fn(),
    delete: vi.fn(),
    classify: vi.fn()
  } as unknown as KnowledgeStore
}

describe('KnowledgeRetrievalPipeline', () => {
  it('does not apply engineering pyramid layers to ordinary legal queries', async () => {
    const calls: Array<Record<string, unknown>> = []
    const store = fakeStore(async (input) => {
      calls.push(input as unknown as Record<string, unknown>)
      return [hit({ index: 1, title: '劳动合同解除研究', relativePath: '论文/劳动合同解除研究.md' })]
    })
    const pipeline = new KnowledgeRetrievalPipeline(store)

    await pipeline.retrieve(
      '请分析企业违法解除劳动合同的责任，重点说明劳动合同法第47条和第87条，并最后输出法律意见书。'
    )

    expect(calls.length).toBeGreaterThanOrEqual(1)
    for (const call of calls) {
      expect(call).not.toHaveProperty('layers')
    }
  })

  it('fuses focused and original long-query results deterministically', async () => {
    let callIndex = 0
    const repeated = hit({ index: 1, title: '经济补偿规则', relativePath: '法规/经济补偿规则.md', score: 15 })
    const store = fakeStore(async () => {
      callIndex += 1
      if (callIndex === 1) {
        return [repeated, hit({ index: 2, title: '解除程序', relativePath: '实务/解除程序.md', score: 20 })]
      }
      return [repeated, hit({ index: 3, title: '意见书模板', relativePath: '模板/意见书模板.md', score: 30 })]
    })
    const pipeline = new KnowledgeRetrievalPipeline(store)

    const result = await pipeline.retrieve(
      '请全面分析违法解除劳动合同的经济补偿与赔偿金规则，并结合案例说明。最后输出一份3000字法律意见书，使用两级标题。'
    )

    expect(callIndex).toBe(2)
    expect(result.sources[0]?.path).toContain('经济补偿规则')
  })

  it('only returns source metadata for excerpts that actually fit the context budget', async () => {
    const store = fakeStore(async () => [
      hit({
        index: 1,
        title: '来源一',
        relativePath: '论文/来源一.md',
        snippet: '甲'.repeat(500)
      }),
      hit({
        index: 2,
        title: '来源二',
        relativePath: '论文/来源二.md',
        snippet: '乙'.repeat(500)
      })
    ])
    const pipeline = new KnowledgeRetrievalPipeline(store)

    const result = await pipeline.retrieve('劳动合同法律责任', { maxChars: 700 })

    expect(result.sources).toHaveLength(1)
    expect(result.citations).toHaveLength(1)
    expect(result.contextText).toContain('匹配 1 个来源')
    expect(result.contextText).toContain('来源一')
    expect(result.contextText).not.toContain('来源二')
  })
})
