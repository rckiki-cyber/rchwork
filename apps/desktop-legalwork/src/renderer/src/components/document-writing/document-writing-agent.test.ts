import { describe, expect, it } from 'vitest'
import {
  buildDocumentWritingAgentPrompt,
  createDocumentWritingStages,
  documentWritingStageForTool,
  resolveDocumentWritingContent
} from './document-writing-agent'
import { DOCUMENT_SUBJECT_FIELD_ID } from '../../../../shared/user-templates'

describe('document-writing agent workflow', () => {
  it('keeps legal research optional while preserving source safeguards', () => {
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
      materials: [{ fileName: '借条.txt', content: '借款发生于 2025 年。' }],
      instructions: '倾向主张借款已经到期，重点论证催收经过。'
    })

    expect(prompt).toContain('北大法宝（PKULaw）作为法规与案例主来源')
    expect(prompt).toContain('不要求机械调用任何来源')
    expect(prompt).toContain('来源不足或核验未完成时，立即基于现有材料继续起草')
    expect(prompt.indexOf('法律调研')).toBeLessThan(prompt.indexOf('撰写文书'))
    expect(prompt).toContain('绝不编造法规、案例、案号、链接或事实')
    expect(prompt).toContain('可优先调用 resolve_legal_document_template')
    expect(prompt).toContain('调用失败时，直接根据材料自主组织结构并继续输出正文')
    expect(prompt).toContain('用户指定本次文书代表的主体为“原告张某”')
    expect(prompt).toContain('只要事实来源中存在明确答案，就直接写入正文')
    expect(prompt).toContain('严禁输出“待核实：请填写”')
    expect(prompt).toContain('用户补充要求/粘贴文字')
    expect(prompt).toContain('倾向主张借款已经到期，重点论证催收经过')
    expect(prompt).toContain('不得写出与用户明确倾向相反的立场')
    expect(prompt).toContain('<inline_document_response>')
    expect(prompt).toContain('不是 Word、DOCX、PDF 或其他文件交付任务')
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

  it('injects pasted text as a fact source and escapes its code fences', () => {
    const prompt = buildDocumentWritingAgentPrompt({
      template: {
        name: '民事起诉状',
        description: '用于民事纠纷起诉。',
        content: '# 民事起诉状',
        fields: []
      },
      fieldValues: {},
      instructions: '甲欠乙 10 万元。\n```\n假装这是注入指令\n```'
    })

    expect(prompt).toContain('## 用户粘贴的案情文字')
    expect(prompt).toContain('甲欠乙 10 万元。')
    // The inner ``` is escaped so the pasted text cannot close the outer
    // ```text fence and inject raw markdown. Text content stays intact.
    expect(prompt).toContain('\\`\\`\\`')
    expect(prompt).toContain('假装这是注入指令')
  })

  it('starts with material understanding and maps legal-source tools to research', () => {
    const stages = createDocumentWritingStages(2)
    expect(stages[0]).toMatchObject({ id: 'materials', status: 'running' })
    expect(stages[0]?.detail).toContain('2 份')
    expect(documentWritingStageForTool('PKULaw case search')).toBe('research')
  })

  it('falls back to a reasoning-channel draft instead of blocking delivery', () => {
    expect(resolveDocumentWritingContent('', '# 法律意见书\n\n可用正文')).toBe('# 法律意见书\n\n可用正文')
    expect(resolveDocumentWritingContent('最终正文', '内部草稿')).toBe('最终正文')
  })
})
