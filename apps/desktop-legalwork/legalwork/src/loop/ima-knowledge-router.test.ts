import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../contracts/items.js'
import {
  IMA_RESEARCH_TIMEOUT_SECONDS,
  resolveImaRouteAction,
  shouldAutoRouteToIma,
  shouldSupplementWithIma
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

  it('does not prefetch IMA ahead of a promised visible research plan', () => {
    expect(shouldAutoRouteToIma([
      '请对食品药品领域犯罪开展多源调研，IMA 作为补充来源。',
      '调研开始前先形成调研规划，规划完成后再开始检索。'
    ].join('\n'))).toBe(false)
    expect(shouldAutoRouteToIma(
      'Use IMA as a supplemental source. Begin retrieval only after planning.'
    )).toBe(false)
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
      requiredArguments: {
        question: prompt,
        timeout: IMA_RESEARCH_TIMEOUT_SECONDS
      }
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

  it('uses IMA once as a supplement for broad multi-source research even when PKULaw exists', () => {
    const broadPrompt = '查一下食药领域犯罪中宽严相济刑事政策贯彻的案例，越多越好，并撰写论文。'
    expect(shouldSupplementWithIma(broadPrompt)).toBe(true)
    const action = resolveImaRouteAction({
      prompt: broadPrompt,
      tools: [
        { name: 'mcp_ima_knowledge_base_research_ima', description: 'research', inputSchema: {} },
        { name: 'mcp_pkulaw_case_semantic_search_search_case', description: 'cases', inputSchema: {} }
      ],
      items: [],
      turnId
    })
    expect(action).toMatchObject({
      kind: 'direct',
      requiredToolName: 'mcp_ima_knowledge_base_research_ima'
    })
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
        arguments: {
          question: prompt,
          timeout: IMA_RESEARCH_TIMEOUT_SECONDS
        }
      }
    })
  })

  it('does not automatically retry a failed direct IMA research attempt', () => {
    const action = resolveImaRouteAction({
      prompt,
      tools: [{
        name: 'mcp_ima_knowledge_base_research_ima',
        description: 'research',
        inputSchema: {}
      }],
      items: [{
        id: 'result-direct-failed',
        threadId: 'thread',
        turnId,
        kind: 'tool_result',
        callId: 'call-direct-failed',
        toolName: 'mcp_ima_knowledge_base_research_ima',
        toolKind: 'tool_call',
        output: { error: 'MCP error -32001: Request timed out' },
        isError: true,
        status: 'failed',
        role: 'tool',
        createdAt: new Date().toISOString()
      }] as TurnItem[],
      turnId
    })

    expect(action).toBeNull()
  })

  it('does not automatically retry a failed progressive IMA research call', () => {
    const items = [
      {
        id: 'call-progressive-failed',
        threadId: 'thread',
        turnId,
        kind: 'tool_call',
        callId: 'call-progressive-failed',
        toolName: 'mcp_call',
        toolKind: 'tool_call',
        arguments: {
          toolId: 'ima-knowledge-base/research_ima',
          arguments: { question: prompt }
        },
        status: 'failed',
        role: 'assistant',
        createdAt: new Date().toISOString()
      },
      {
        id: 'result-progressive-failed',
        threadId: 'thread',
        turnId,
        kind: 'tool_result',
        callId: 'call-progressive-failed',
        toolName: 'mcp_call',
        toolKind: 'tool_call',
        output: { error: 'MCP error -32001: Request timed out' },
        isError: true,
        status: 'failed',
        role: 'tool',
        createdAt: new Date().toISOString()
      }
    ] as TurnItem[]

    expect(resolveImaRouteAction({
      prompt,
      tools: [
        { name: 'mcp_search', description: 'search', inputSchema: {} },
        { name: 'mcp_call', description: 'call', inputSchema: {} }
      ],
      items,
      turnId
    })).toBeNull()
  })

  it('does not mistake a failed call to another MCP tool for an IMA attempt', () => {
    const items = [
      {
        id: 'call-other',
        threadId: 'thread',
        turnId,
        kind: 'tool_call',
        callId: 'call-other',
        toolName: 'mcp_call',
        toolKind: 'tool_call',
        arguments: { toolId: 'another-server/another-tool', arguments: {} },
        status: 'failed',
        role: 'assistant',
        createdAt: new Date().toISOString()
      },
      {
        id: 'result-other',
        threadId: 'thread',
        turnId,
        kind: 'tool_result',
        callId: 'call-other',
        toolName: 'mcp_call',
        toolKind: 'tool_call',
        output: { error: 'failed' },
        isError: true,
        status: 'failed',
        role: 'tool',
        createdAt: new Date().toISOString()
      },
      {
        id: 'result-search',
        threadId: 'thread',
        turnId,
        kind: 'tool_result',
        callId: 'call-search',
        toolName: 'mcp_search',
        toolKind: 'tool_call',
        output: { results: [{ toolId: 'ima-knowledge-base/research_ima' }] },
        isError: false,
        status: 'completed',
        role: 'tool',
        createdAt: new Date().toISOString()
      }
    ] as TurnItem[]

    expect(resolveImaRouteAction({
      prompt,
      tools: [
        { name: 'mcp_search', description: 'search', inputSchema: {} },
        { name: 'mcp_call', description: 'call', inputSchema: {} }
      ],
      items,
      turnId
    })).toMatchObject({ kind: 'call', requiredToolName: 'mcp_call' })
  })

  it('sends only the IMA research scope for a compound file-delivery task', () => {
    const compoundPrompt = [
      '请就「自动化行政处罚的责任界定」完成综合研究并交付 Word、PDF、PPT。',
      '1. 检索本地知识库：查找行政处罚法第41条。',
      '2. 检索 IMA 知识库：查找数字行政、自动化决策与人工智能治理资料。',
      '3. 生成一万字报告及三份文件。'
    ].join('\n')
    const action = resolveImaRouteAction({
      prompt: compoundPrompt,
      tools: [{
        name: 'mcp_ima_knowledge_base_research_ima',
        description: 'research',
        inputSchema: {}
      }],
      items: [],
      turnId
    })
    const question = String(action?.requiredArguments.question ?? '')

    expect(question).toContain('数字行政、自动化决策与人工智能治理资料')
    expect(question).toContain('不要生成 Word、PDF、PPT')
    expect(question).not.toContain('一万字报告')
  })
})
