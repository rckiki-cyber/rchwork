import { describe, expect, it } from 'vitest'
import { splitLegacyKnowledgeReasoning } from './KnowledgeReasoningBlock'

describe('splitLegacyKnowledgeReasoning', () => {
  it('extracts reasoning and answer from legacy details markup', () => {
    const input = [
      '<details style="margin-bottom:8px;font-size:0.85em">',
      '<summary style="cursor:pointer"><span>💭</span> 思考过程</summary>',
      '',
      '用户打开了一个 PDF，我需要根据正文回答。',
      '',
      '</details>',
      '',
      '## 基本信息',
      '',
      '这是一份实习简历。'
    ].join('\n')

    expect(splitLegacyKnowledgeReasoning(input)).toEqual({
      reasoning: '用户打开了一个 PDF，我需要根据正文回答。',
      content: '## 基本信息\n\n这是一份实习简历。'
    })
  })

  it('preserves ordinary Markdown and unrelated HTML', () => {
    const input = '## 回答\n\n<details>补充内容</details>'
    expect(splitLegacyKnowledgeReasoning(input)).toEqual({
      reasoning: '',
      content: input
    })
  })
})
