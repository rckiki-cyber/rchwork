import { describe, expect, it } from 'vitest'
import {
  buildDocumentWritingAgentPrompt,
  createDocumentWritingStages,
  documentWritingStageForTool
} from './document-writing-agent'
import { DOCUMENT_SUBJECT_FIELD_ID } from '../../../../shared/user-templates'

describe('document-writing agent workflow', () => {
  it('requires legal research before drafting and preserves source safeguards', () => {
    const prompt = buildDocumentWritingAgentPrompt({
      template: {
        name: '民事起诉状',
        description: '用于民事纠纷起诉。',
        content: '# 民事起诉状',
        fields: [{ id: 'claim', label: '诉讼请求', type: 'textarea', required: true }]
      },
      fieldValues: {
        claim: '请求返还借款。',
        [DOCUMENT_SUBJECT_FIELD_ID]: '原告张某'
      },
      materials: [{ fileName: '借条.txt', content: '借款发生于 2025 年。' }]
    })

    expect(prompt).toContain('北大法宝（PKULaw）、元典')
    expect(prompt.indexOf('法律调研')).toBeLessThan(prompt.indexOf('撰写文书'))
    expect(prompt).toContain('绝不编造法规、案例、案号、链接或事实')
    expect(prompt).toContain('必须先调用 resolve_legal_document_template')
    expect(prompt).toContain('用户明确指定本次文书代表的主体为“原告张某”')
    expect(prompt).toContain('只要材料中存在明确答案，就直接写入正文')
    expect(prompt).toContain('严禁输出“待核实：请填写”')
  })

  it('keeps a user-uploaded template above hidden built-ins', () => {
    const prompt = buildDocumentWritingAgentPrompt({
      template: {
        id: 'custom-123',
        name: '客户专用起诉状',
        description: '用户上传模板：客户专用起诉状.docx',
        content: '# 客户专用起诉状\n\n## 客户固定结构',
        fields: [],
        source: 'user'
      },
      fieldValues: {}
    })

    expect(prompt).toContain('用户上传模板（最高优先级）')
    expect(prompt).toContain('不得调用或改用隐藏内置模板')
    expect(prompt).not.toContain('必须先调用 resolve_legal_document_template')
  })

  it('starts with material understanding and maps legal-source tools to research', () => {
    const stages = createDocumentWritingStages(2)
    expect(stages[0]).toMatchObject({ id: 'materials', status: 'running' })
    expect(stages[0]?.detail).toContain('2 份')
    expect(documentWritingStageForTool('PKULaw case search')).toBe('research')
  })
})
