import { describe, expect, it } from 'vitest'
import { applyLegalResearchSummaryEdit } from './legal-research-records'

describe('applyLegalResearchSummaryEdit', () => {
  it('makes an edited Markdown table the canonical report content', () => {
    const original = [
      '| 事项 | 结论 |',
      '| --- | --- |',
      '| 诉讼时效 | 三年 |'
    ].join('\n')
    const edited = [
      '| 事项 | 结论 |',
      '| --- | --- |',
      '| 诉讼时效 | 四年 |'
    ].join('\n')

    const records = [
      { id: 'target', summary: original },
      { id: 'other', summary: '# 其他报告' }
    ]
    const updated = applyLegalResearchSummaryEdit(records, 'target', edited, 123)

    expect(updated[0]).toMatchObject({
      summary: edited,
      editedSummary: edited,
      reportRevision: 123,
      updatedAt: 123
    })
    expect(updated[1]).toBe(records[1])
  })
})
