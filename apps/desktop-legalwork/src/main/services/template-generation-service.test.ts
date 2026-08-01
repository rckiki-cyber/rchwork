import { describe, expect, it } from 'vitest'
import { DOCUMENT_SUBJECT_FIELD_ID } from '../../shared/user-templates'
import { buildGenerationPrompt } from './template-generation-service'

describe('template generation legal formatting prompt', () => {
  it('injects the selected document type format card', () => {
    const { systemPrompt } = buildGenerationPrompt({
      template: {
        id: 'legal-opinion',
        name: '法律意见书',
        description: '法律分析意见',
        content: '# 法律意见书\n\n{{content}}',
        fields: [{ id: 'content', label: '事项', type: 'textarea' }]
      },
      fieldValues: { content: '测试事项' }
    })

    expect(systemPrompt).toContain('文书体例：律师事务所专业文书')
    expect(systemPrompt).toContain('致送对象')
    expect(systemPrompt).toContain('一级到四级层次必须遵循')
    expect(systemPrompt).toContain('禁止把连续叙事机械拆成 1、2、3、4')
    expect(systemPrompt).not.toContain('生成完整的法律文书，包含标题、当事人信息')
  })

  it('uses contract article numbering for contracts', () => {
    const { systemPrompt } = buildGenerationPrompt({
      template: {
        id: 'sales-contract',
        name: '买卖合同',
        description: '',
        content: '# 买卖合同',
        fields: []
      },
      fieldValues: {}
    })
    expect(systemPrompt).toContain('第一条、第二条')
    expect(systemPrompt).toContain('签署页')
    expect(systemPrompt).toContain('不要用“此致”')
  })

  it('preserves the highest priority for user-uploaded templates', () => {
    const { systemPrompt } = buildGenerationPrompt({
      template: {
        id: 'custom-client-complaint',
        name: '客户专用起诉状',
        description: '用户上传模板',
        content: '# 客户专用起诉状',
        fields: [],
        source: 'user'
      },
      fieldValues: {}
    })

    expect(systemPrompt).toContain('当前模板为用户上传模板，具有最高优先级')
    expect(systemPrompt).toContain('不能用通用结构替换')
  })

  it('treats empty fields as material extraction targets and preserves the user-confirmed side', () => {
    const { systemPrompt, userPrompt } = buildGenerationPrompt({
      template: {
        id: 'authorization',
        name: '授权委托书',
        description: '诉讼授权',
        content: '# 授权委托书',
        fields: [
          { id: 'representative', label: '法定代表人', type: 'text', required: true },
          { id: 'address', label: '住所', type: 'text', required: true }
        ]
      },
      fieldValues: {
        [DOCUMENT_SUBJECT_FIELD_ID]: '被告蓝尚宝商贸有限公司'
      },
      materials: [{
        fileName: '判决书.txt',
        content: '被告蓝尚宝商贸有限公司，法定代表人陈某。'
      }],
      instructions: '倾向维护被告立场，重点说明已履行部分义务。'
    })

    expect(userPrompt).toContain('被告蓝尚宝商贸有限公司')
    expect(userPrompt).toContain('未填写；有材料时必须先从全部材料主动提取')
    expect(systemPrompt).toContain('只要有明确答案就直接写入')
    expect(systemPrompt).toContain('禁止输出“待核实：请填写”')
    expect(systemPrompt).toContain('不得写出与用户明确倾向相反的立场')
    expect(userPrompt).toContain('用户补充要求（立场、倾向、目标与重点；必须优先落实）')
    expect(userPrompt).toContain('倾向维护被告立场，重点说明已履行部分义务')
  })
})
