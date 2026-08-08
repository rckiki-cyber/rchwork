import { describe, expect, it } from 'vitest'
import {
  documentTaskContract,
  validateDocumentContent
} from '../src/loop/document-task-contract.js'

describe('document task contract', () => {
  const prompt = [
    '请重点研读至少 3 篇 PDF，并执行 OCR。',
    '演示脱敏处理并产出脱敏后的版本。',
    '撰写一份不少于 1200 字的报告：',
    '- 一、问题的提出',
    '- 二、规范体系',
    '- 参考文献（标注来源）',
    '分析 2-3 个典型案例，文件名含「数字行政法体系建构研究报告」。',
    '禁止省略号和占位符。'
  ].join('\n')

  it('extracts the explicit requirements from a multi-stage prompt', () => {
    expect(documentTaskContract(prompt)).toEqual({
      minimumContentCharacters: 1200,
      requiredHeadings: ['一、问题的提出', '二、规范体系', '参考文献'],
      minimumCaseCount: 2,
      requiredFilenameFragment: '数字行政法体系建构研究报告',
      forbidPlaceholders: true,
      requiredKnowledgePdfReads: 3,
      requiresDesensitization: true
    })
  })

  it('rejects an incomplete draft and accepts a complete one', () => {
    const contract = documentTaskContract(prompt)
    const incomplete = '# 一、问题的提出\n\n内容待补充……'
    expect(validateDocumentContent(incomplete, contract)).toEqual(expect.arrayContaining([
      expect.stringContaining('1200'),
      expect.stringContaining('二、规范体系'),
      expect.stringContaining('参考文献'),
      expect.stringContaining('2 个典型案例'),
      expect.stringContaining('省略号或占位'),
      expect.stringContaining('脱敏处理')
    ]))

    const complete = [
      '# 一、问题的提出',
      '# 二、规范体系',
      '脱敏策略采用去标识化并保留可核验的主体映射。',
      '典型案例：（2019）鲁13行终415号；（2021）京01行终88号。',
      '正文内容。'.repeat(300),
      '# 参考文献'
    ].join('\n')
    expect(validateDocumentContent(complete, contract)).toEqual([])
  })
})
