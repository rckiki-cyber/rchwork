import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../contracts/items.js'
import {
  resolveImaRouteAction,
  shouldAutoRouteToIma
} from './ima-knowledge-router.js'

const prompt = '请分析企业解除劳动合同的合规风险和法律依据'
const turnId = 'turn-ima'

describe('IMA knowledge router', () => {
  it('recognizes knowledge-heavy legal work without requiring an explicit IMA mention', () => {
    expect(shouldAutoRouteToIma(prompt)).toBe(true)
    expect(shouldAutoRouteToIma('你好')).toBe(false)
    expect(shouldAutoRouteToIma('只使用北大法宝查询劳动合同法')).toBe(false)
    expect(shouldAutoRouteToIma('请不要调用 IMA，直接回答')).toBe(false)
    expect(shouldAutoRouteToIma('只基于我提供的附件起草劳动合同')).toBe(false)
    expect(shouldAutoRouteToIma('如何给 IMA 知识库做 RAG 路由')).toBe(false)
    expect(shouldAutoRouteToIma('请起草一份劳动合同')).toBe(false)
  })

  it('requires the direct research tool when MCP tools are advertised directly', () => {
    const action = resolveImaRouteAction({
      prompt,
      tools: [{
        name: 'mcp_ima_knowledge_base_research_ima',
        description: 'research',
        inputSchema: {}
      }],
      items: [],
      turnId
    })
    expect(action).toMatchObject({
      kind: 'direct',
      requiredToolName: 'mcp_ima_knowledge_base_research_ima',
      requiredArguments: { question: prompt }
    })
  })

  it('does not force IMA ahead of an available PKULaw source', () => {
    const action = resolveImaRouteAction({
      prompt,
      tools: [
        {
          name: 'mcp_ima_knowledge_base_research_ima',
          description: 'research',
          inputSchema: {}
        },
        {
          name: 'mcp_pkulaw_law_search_search_article',
          description: 'search laws',
          inputSchema: {}
        },
        {
          name: 'mcp_pkulaw_case_semantic_search_search_case',
          description: 'search cases',
          inputSchema: {}
        }
      ],
      items: [],
      turnId
    })

    expect(action).toBeNull()
  })

  it('still honors an explicit request to use IMA first', () => {
    const imaFirstPrompt = '请先调用 IMA，再分析企业解除劳动合同的法律风险'
    const action = resolveImaRouteAction({
      prompt: imaFirstPrompt,
      tools: [
        {
          name: 'mcp_ima_knowledge_base_research_ima',
          description: 'research',
          inputSchema: {}
        },
        {
          name: 'mcp_pkulaw_law_search_search_article',
          description: 'search laws',
          inputSchema: {}
        }
      ],
      items: [],
      turnId
    })

    expect(action).toMatchObject({
      kind: 'direct',
      requiredToolName: 'mcp_ima_knowledge_base_research_ima'
    })
  })

  it('discovers and then calls research_ima in progressive MCP mode', () => {
    const discover = resolveImaRouteAction({
      prompt,
      tools: [
        { name: 'mcp_search', description: 'search', inputSchema: {} },
        { name: 'mcp_call', description: 'call', inputSchema: {} }
      ],
      items: [],
      turnId
    })
    expect(discover).toMatchObject({
      kind: 'discover',
      requiredToolName: 'mcp_search'
    })

    const items = [{
      id: 'result-search',
      threadId: 'thread',
      turnId,
      kind: 'tool_result',
      callId: 'call-search',
      toolName: 'mcp_search',
      toolKind: 'tool_call',
      output: {
        results: [{ toolId: 'ima-knowledge-base/research_ima' }]
      },
      isError: false,
      status: 'completed',
      createdAt: new Date().toISOString()
    }] as TurnItem[]
    const call = resolveImaRouteAction({
      prompt,
      tools: [
        { name: 'mcp_search', description: 'search', inputSchema: {} },
        { name: 'mcp_call', description: 'call', inputSchema: {} }
      ],
      items,
      turnId
    })
    expect(call).toMatchObject({
      kind: 'call',
      requiredToolName: 'mcp_call',
      requiredArguments: {
        toolId: 'ima-knowledge-base/research_ima',
        arguments: { question: prompt }
      }
    })
  })
})
