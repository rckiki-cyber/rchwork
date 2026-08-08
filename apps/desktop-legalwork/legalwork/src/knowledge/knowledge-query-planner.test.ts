import { describe, expect, it } from 'vitest'
import { buildKnowledgeRetrievalQueries } from './knowledge-query-planner.js'

describe('buildKnowledgeRetrievalQueries', () => {
  it('keeps short legal questions as a single deterministic query', () => {
    expect(buildKnowledgeRetrievalQueries('劳动合同法第47条如何计算经济补偿？'))
      .toEqual(['劳动合同法第47条如何计算经济补偿?'])
  })

  it('adds a focused retrieval query for long task prompts', () => {
    const query = [
      '请认真分析企业违法解除劳动合同的法律责任，重点考虑《劳动合同法》第47条和第87条。',
      '结合相关裁判案例说明经济补偿金与赔偿金的关系。',
      '最后请输出一份3000字法律意见书，采用一级标题和二级标题。'
    ].join('')
    const planned = buildKnowledgeRetrievalQueries(query)

    expect(planned).toHaveLength(2)
    expect(planned[0]).toContain('劳动合同法')
    expect(planned[0]).toContain('第47条')
    expect(planned[0]).not.toContain('3000字法律意见书')
    expect(planned[1]).toContain('3000字法律意见书')
  })

  it('bounds very long original prompts while preserving both ends', () => {
    const query = `劳动争议 ${'背景事实'.repeat(300)} 最终争议焦点是竞业限制补偿标准`
    const planned = buildKnowledgeRetrievalQueries(query)

    expect(planned.at(-1)?.length).toBeLessThanOrEqual(800)
    expect(planned.at(-1)).toContain('劳动争议')
    expect(planned.at(-1)).toContain('竞业限制补偿标准')
  })
})
