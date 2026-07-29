import { describe, expect, it } from 'vitest'
import {
  preprocessLegalResearchSummary,
  resolveLegalResearchMarkdown
} from './legal-research-markdown'

describe('resolveLegalResearchMarkdown', () => {
  it('uses the generated Markdown before a report has been edited', () => {
    expect(resolveLegalResearchMarkdown({ summary: '# 原始报告' })).toBe('# 原始报告')
  })

  it('uses the saved edited Markdown, including an intentionally empty report', () => {
    expect(
      resolveLegalResearchMarkdown({
        summary: '# 原始报告',
        editedSummary: '# 编辑后的报告'
      })
    ).toBe('# 编辑后的报告')
    expect(resolveLegalResearchMarkdown({ summary: '# 原始报告', editedSummary: '' })).toBe('')
  })
})

describe('preprocessLegalResearchSummary', () => {
  it('wraps box-drawing legal framework diagrams in a text fence', () => {
    const input = [
      '自动驾驶汽车交通事故责任框架（中国现行框架）',
      '┌────────────────────┐ | 事故发生 |',
      '└────────────────────┘ ▼',
      '┌────────────────────┐ | 第一层：交强险先行赔付 |',
      '└────────────────────┘ ▼',
      '6.2 核心法律不确定性'
    ].join('\n')

    expect(preprocessLegalResearchSummary(input)).toBe([
      '自动驾驶汽车交通事故责任框架（中国现行框架）',
      '```text',
      '┌────────────────────┐ | 事故发生 |',
      '└────────────────────┘ ▼',
      '┌────────────────────┐ | 第一层：交强险先行赔付 |',
      '└────────────────────┘ ▼',
      '```',
      '6.2 核心法律不确定性'
    ].join('\n'))
  })

  it('preserves ordinary GFM tables', () => {
    const input = [
      '| 风险点 | 风险等级 | 说明 |',
      '| --- | --- | --- |',
      '| 责任主体不明 | 高 | 需要结合产品责任与侵权责任判断 |'
    ].join('\n')

    expect(preprocessLegalResearchSummary(input)).toBe(input)
  })

  it('does not rewrite existing fenced code blocks', () => {
    const input = [
      '```text',
      'A||B',
      '┌──┐',
      '```'
    ].join('\n')

    expect(preprocessLegalResearchSummary(input)).toBe(input)
  })

  it('preserves Markdown links returned by legal research tools', () => {
    const input = [
      '适用法规：',
      '- [《个人信息出境标准合同办法》](https://www.pkulaw.com/law/example)',
      '- <https://www.pkulaw.com/case/example>'
    ].join('\n')

    expect(preprocessLegalResearchSummary(input)).toBe(input)
  })
})
