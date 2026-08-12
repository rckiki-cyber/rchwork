import { describe, expect, it } from 'vitest'
import {
  bestAvailableLegalResearchText,
  isCompleteLegalResearchReportText,
  splitLegalResearchMessage
} from './legal-research-message'

describe('legal research message classification', () => {
  it('separates a plan from an appended stage update', () => {
    const parts = splitLegalResearchMessage([
      '## 调研规划',
      '1. 核验规范',
      '2. 检索案例',
      '3. 综合分析',
      '',
      '---',
      '',
      '**第一阶段播报**：已完成初检。下一步继续检索。'
    ].join('\n'))
    expect(parts.planning).toContain('## 调研规划')
    expect(parts.planning).not.toContain('第一阶段播报')
    expect(parts.update).toContain('第一阶段播报')
    expect(parts.report).toBe('')
    expect(parts.reportComplete).toBe(false)
  })

  it('does not treat a plan or progress update as a final report', () => {
    expect(isCompleteLegalResearchReportText(
      '## 调研规划\n\n1. 核验规范\n2. 检索案例\n\n**第一阶段播报**：下一步继续。'
    )).toBe(false)
  })

  it('recognizes a complete Chinese Markdown report and keeps it out of stage updates', () => {
    const report = [
      '# 食品药品犯罪宽严相济调研报告',
      '## 一、结论',
      '结论内容。'.repeat(20),
      '## 二、法律依据',
      '依据内容。'.repeat(15),
      '## 三、相关案例',
      '案例内容。'.repeat(15),
      '## 四、分析与风险提示',
      '分析内容。'.repeat(15),
      '## 五、来源',
      '来源内容。'.repeat(10)
    ].join('\n\n')
    const parts = splitLegalResearchMessage(report)
    expect(parts.report).toBe(report)
    expect(parts.reportComplete).toBe(true)
    expect(parts.update).toBe('')
  })

  it('surfaces a partial final report while it is still streaming', () => {
    const partial = '# 食品药品犯罪调研报告\n\n## 结论\n\n正在生成正文'
    const parts = splitLegalResearchMessage(partial)
    expect(parts.report).toBe(partial)
    expect(parts.reportComplete).toBe(false)
    expect(parts.update).toBe('')
  })

  it('keeps the best available text even when it does not pass the report shape heuristic', () => {
    expect(bestAvailableLegalResearchText([
      '阶段更新：已取得一份材料。',
      '这是没有固定章节但仍可交付的法律分析。'
    ])).toBe('这是没有固定章节但仍可交付的法律分析。')
  })

  it('never uses stage broadcasts or model reasoning as the research summary', () => {
    expect(bestAvailableLegalResearchText([
      '阶段播报1：工具已就绪。',
      '已有充足材料。继续补充获取民法典关键条文与北大法宝补充。'
    ])).toBe('')
    expect(bestAvailableLegalResearchText([], '让我先搜索可用的 MCP 工具。')).toBe('')
  })
})
