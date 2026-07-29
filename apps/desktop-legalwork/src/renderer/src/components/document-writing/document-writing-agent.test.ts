import { describe, expect, it } from 'vitest'
import {
  buildDocumentWritingAgentPrompt,
  createDocumentWritingStages,
  documentWritingStageForTool
} from './document-writing-agent'

describe('document-writing agent workflow', () => {
  it('requires legal research before drafting and preserves source safeguards', () => {
    const prompt = buildDocumentWritingAgentPrompt({
      template: {
        name: '民事起诉状',
        description: '用于民事纠纷起诉。',
        content: '# 民事起诉状',
        fields: [{ id: 'claim', label: '诉讼请求', type: 'textarea', required: true }]
      },
      fieldValues: { claim: '请求返还借款。' },
      materials: [{ fileName: '借条.txt', content: '借款发生于 2025 年。' }]
    })

    expect(prompt).toContain('北大法宝（PKULaw）、元典')
    expect(prompt.indexOf('法律调研')).toBeLessThan(prompt.indexOf('撰写文书'))
    expect(prompt).toContain('绝不编造法规、案例、案号、链接或事实')
  })

  it('starts with material understanding and maps legal-source tools to research', () => {
    const stages = createDocumentWritingStages(2)
    expect(stages[0]).toMatchObject({ id: 'materials', status: 'running' })
    expect(stages[0]?.detail).toContain('2 份')
    expect(documentWritingStageForTool('PKULaw case search')).toBe('research')
  })
})
