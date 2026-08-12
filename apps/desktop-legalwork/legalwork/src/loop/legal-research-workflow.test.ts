import { describe, expect, it } from 'vitest'
import {
  hasDiscoveredPrimaryLegalDatabaseTool,
  hasUsablePrimaryLegalCaseEvidence,
  hasUsablePrimaryLegalDatabaseEvidence,
  isCompleteLegalResearchReport,
  isLegalResearchWorkflowPrompt,
  isPublishedLegalResearchPlan,
  isRedundantLegalSourceEnrichmentCall
} from './legal-research-workflow.js'
import { makeToolResultItem } from '../domain/item.js'

describe('legal research workflow', () => {
  it('recognizes the dedicated research prompt', () => {
    expect(isLegalResearchWorkflowPrompt(
      '请对以下法律问题进行多源调研：「测试」。最终报告必须作为最后一条独立回复。'
    )).toBe(true)
  })

  it('recognizes a published plan but not a stage update as a final report', () => {
    const text = [
      '## 调研规划',
      '1. 核验规范',
      '2. 检索案例',
      '3. 综合分析',
      '',
      '**第一阶段播报**：已完成初检，下一步继续检索。'
    ].join('\n')
    expect(isPublishedLegalResearchPlan(text)).toBe(true)
    expect(isCompleteLegalResearchReport(text)).toBe(false)
  })

  it('requires substantive final-report sections', () => {
    const report = [
      '# 测试问题多源调研报告',
      '## 一、结论',
      '结论正文。'.repeat(30),
      '## 二、法律依据',
      '依据正文。'.repeat(20),
      '## 三、相关案例',
      '案例正文。'.repeat(20),
      '## 四、分析与风险提示',
      '分析正文。'.repeat(20),
      '## 五、来源',
      '来源正文。'.repeat(10)
    ].join('\n\n')
    expect(isCompleteLegalResearchReport(report)).toBe(true)
  })

  it('accepts usable Yuandian law content as primary legal evidence', () => {
    const item = makeToolResultItem({
      id: 'result_1',
      threadId: 'thread_1',
      turnId: 'turn_1',
      callId: 'call_1',
      toolName: 'mcp_call',
      output: {
        serverId: 'yuandian-law',
        toolName: 'yuandian_law_vector_search',
        result: { content: [{ type: 'text', text: '《中华人民共和国刑法》第一百三十三条之一现行条文。'.repeat(8) }] }
      }
    })
    expect(hasUsablePrimaryLegalDatabaseEvidence([item], 'turn_1')).toBe(true)
  })

  it('recognizes usable Yuandian case content as the final synthesis trigger', () => {
    const item = makeToolResultItem({
      id: 'result_case',
      threadId: 'thread_1',
      turnId: 'turn_1',
      callId: 'call_case',
      toolName: 'mcp_call',
      output: {
        serverId: 'yuandian-case',
        toolName: 'yuandian_rh_qwal_search',
        result: { content: [{ type: 'text', text: '（2022）京02刑终376号裁判要旨及基本案情。'.repeat(8) }] }
      }
    })
    expect(hasUsablePrimaryLegalCaseEvidence([item], 'turn_1')).toBe(true)
  })

  it('recognizes a concrete primary database tool discovered through MCP search', () => {
    const item = makeToolResultItem({
      id: 'result_discovery',
      threadId: 'thread_1',
      turnId: 'turn_1',
      callId: 'call_discovery',
      toolName: 'mcp_search',
      output: {
        results: [{
          toolId: 'yuandian-law/yuandian_law_vector_search',
          serverId: 'yuandian-law',
          title: '法律法规语义检索接口'
        }]
      }
    })
    expect(hasDiscoveredPrimaryLegalDatabaseTool([item], 'turn_1')).toBe(true)
  })

  it('does not treat MCP tool discovery as primary legal evidence', () => {
    const item = makeToolResultItem({
      id: 'result_discovery',
      threadId: 'thread_1',
      turnId: 'turn_1',
      callId: 'call_discovery',
      toolName: 'mcp_search',
      output: {
        results: [{
          toolId: 'yuandian-law/yuandian_law_vector_search',
          serverId: 'yuandian-law',
          title: '法律法规语义检索接口'
        }, {
          toolId: 'pkulaw-case-number-recognition/anhao_recognition',
          serverId: 'pkulaw-case-number-recognition',
          title: '案号识别与标准化'
        }]
      }
    })
    expect(hasUsablePrimaryLegalDatabaseEvidence([item], 'turn_1')).toBe(false)
    expect(hasUsablePrimaryLegalCaseEvidence([item], 'turn_1')).toBe(false)
  })

  it('marks web and database link enrichment as redundant after primary evidence', () => {
    expect(isRedundantLegalSourceEnrichmentCall({
      toolName: 'web_fetch',
      arguments: { url: 'https://example.test/law' }
    })).toBe(true)
    expect(isRedundantLegalSourceEnrichmentCall({
      toolName: 'mcp_call',
      arguments: { toolId: 'pkulaw-doc-link/link_enhance' }
    })).toBe(true)
    expect(isRedundantLegalSourceEnrichmentCall({
      toolName: 'mcp_call',
      arguments: { toolId: 'yuandian-law/yuandian_law_vector_search' }
    })).toBe(false)
  })
})
