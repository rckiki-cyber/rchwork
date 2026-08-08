import { describe, expect, it } from 'vitest'
import type { KnowledgeDocument } from '../contracts/knowledge.js'
import {
  citationReferenceSearchQueries,
  extractReferenceEntries,
  verifyPaperCitations
} from './citation-verifier.js'

const document: KnowledgeDocument = {
  id: 'doc-1',
  title: '算法行政的正当程序研究',
  path: '/tmp/算法行政的正当程序研究.pdf',
  sourceRoot: '/tmp',
  relativePath: '论文/算法行政的正当程序研究.pdf',
  extension: '.pdf',
  sizeBytes: 100,
  updatedAt: '2026-08-08T00:00:00.000Z',
  keywords: ['算法行政', '正当程序']
}

describe('citation verifier', () => {
  it('maps numeric in-text citations through the bibliography before matching KB documents', () => {
    const draft = [
      '算法行政必须遵守正当程序[1]。',
      '',
      '## 参考文献',
      '',
      '[1] 张三. 算法行政的正当程序研究[J]. 行政法学研究, 2025(2).'
    ].join('\n')

    const result = verifyPaperCitations(draft, { documents: [document], chunks: [] })

    expect(result.documentStats).toMatchObject({ totalCitations: 1, verified: 1, notFound: 0 })
    expect(result.checks[0]?.matchedDocument?.relativePath).toBe(document.relativePath)
  })

  it('extracts a focused title query from a GB/T bibliography entry', () => {
    expect(citationReferenceSearchQueries(
      '王周户, 马玲燕. 风险社会中自动化行政裁量的规制研究[J]. 杭州师范大学学报, 2025(6): 101-112.'
    )[0]).toBe('风险社会中自动化行政裁量的规制研究')
  })

  it('matches a KB filename that appends the author after the citation title', () => {
    const result = verifyPaperCitations([
      '自动化行政需要程序控制[1]。',
      '## 参考文献',
      '[1] 王周户, 马玲燕. 风险社会中自动化行政裁量的规制研究[J]. 杭州师范大学学报.'
    ].join('\n'), {
      documents: [{
        ...document,
        title: '风险社会中自动化行政裁量的规制研究_王周户.pdf',
        relativePath: '论文/风险社会中自动化行政裁量的规制研究_王周户.pdf'
      }],
      chunks: []
    })

    expect(result.documentStats).toMatchObject({ verified: 1, notFound: 0 })
  })

  it('reports a missing bibliography number instead of searching an empty marker', () => {
    const result = verifyPaperCitations('正文结论[2]。\n\n## 参考文献\n\n[1] 其他文献。', {
      documents: [document],
      chunks: []
    })

    expect(result.documentStats.notFound).toBe(1)
    expect(result.checks[0]?.details).toContain('缺少 [2]')
  })

  it('extracts bracketed and numbered bibliography entries only from the reference section', () => {
    const entries = extractReferenceEntries([
      '1. 正文中的编号标题',
      '## 参考文献',
      '[1] 第一篇文献',
      '2. 第二篇文献'
    ].join('\n'))

    expect(entries.map(({ index, text }) => ({ index, text }))).toEqual([
      { index: 1, text: '第一篇文献' },
      { index: 2, text: '第二篇文献' }
    ])
  })
})
