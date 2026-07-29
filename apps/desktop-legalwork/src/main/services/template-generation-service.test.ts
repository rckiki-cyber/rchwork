import { describe, expect, it } from 'vitest'
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
})
