import { describe, expect, it } from 'vitest'
import { imaReferenceKeys } from './agent-loop.js'

describe('imaReferenceKeys inline @index-ref', () => {
  it('counts inline @index-ref references from research_ima text', () => {
    const output = {
      serverId: 'ima-knowledge-base',
      toolName: 'research_ima',
      result: {
        content: [{
          type: 'text',
          text: '【IMA 自动选库：知识库】\n## 一、规范文件\n1. 最高法意见[1](@index-ref?id=doc_abc123)\n2. 食品安全法解释[2](@index-ref?id=doc_def456)\n3. 药品管理法[3](@index-ref?id=doc_ghi789)'
        }]
      }
    }
    const keys = imaReferenceKeys(output)
    expect(keys.size).toBeGreaterThanOrEqual(3)
    expect([...keys]).toEqual(expect.arrayContaining(['ref:doc_abc123', 'ref:doc_def456', 'ref:doc_ghi789']))
  })

  it('counts refs even when parent key is generic text', () => {
    // IMA 引用嵌在正文段落里，parentKey 是 text，不匹配 文献/来源 等词。
    const text = '政策依据[1](@index-ref?id=doc_aaa)与司法实践[2](@index-ref?id=doc_bbb)'
    const keys = imaReferenceKeys({ text })
    expect(keys.has('ref:doc_aaa')).toBe(true)
    expect(keys.has('ref:doc_bbb')).toBe(true)
  })

  it('counts the actual references returned by research_ima in the real run', () => {
    const text = [
      '【IMA 自动选库：啷个哩个啷的知识库、立法司法资料知识库】',
      '##一、的基础规范与理论文献###（一）核心政策文件',
      '1. 《最高人民法院关于贯彻刑事政策的若干意见》[1](@index-ref?id=doc_111)',
      '2. 《刑法修正案（十一）》[2](@index-ref?id=doc_222)',
      '3. 最高检指导意见[3](@index-ref?id=doc_333)',
      '4. 张明楷刑法学第八版[4](@index-ref?id=chunk_444)'
    ].join('\n')
    const keys = imaReferenceKeys({ content: [{ type: 'text', text }] })
    expect(keys.size).toBeGreaterThanOrEqual(3)
  })

  it('still counts line-based numbered references in a reference block', () => {
    const output = { 来源: '1. 张三. 算法行政研究[J]. 法学研究, 2025.\n2. 李四. 自动化决策[J]. 中国法学, 2024.' }
    const keys = imaReferenceKeys(output)
    expect(keys.size).toBe(2)
  })
})
