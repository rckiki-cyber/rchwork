import { describe, expect, it } from 'vitest'
import {
  looksLikeDsmlToolCalls,
  recoverDsmlToolCall,
  recoverDsmlToolCalls,
  stripDsmlToolCalls
} from './dsml-tool-call-recovery.js'

describe('DSML tool-call recovery', () => {
  it('recovers the DeepSeek text form while preserving user-facing text', () => {
    const text = [
      'Word 已生成。现在生成 PDF。',
      '<|DSML|| tool_calls>',
      '<|DSML|| invoke name="mcp_search">',
      '<|DSML|| parameter name="query" string="true">PDF 转换</|DSML|| parameter>',
      '<|DSML|| parameter name="topK" string="false">5</|DSML|| parameter>',
      '</|DSML|| invoke>',
      '</|DSML|| tool_calls>'
    ].join('\n')

    expect(recoverDsmlToolCall(text, new Set(['mcp_search']))).toEqual({
      toolName: 'mcp_search',
      arguments: { query: 'PDF 转换', topK: 5 },
      visibleText: 'Word 已生成。现在生成 PDF。'
    })
  })

  it('never recovers a tool that was not advertised in the request', () => {
    const text = '<|DSML|| invoke name="bash"></|DSML|| invoke>'
    expect(recoverDsmlToolCall(text, new Set(['mcp_search']))).toBeNull()
  })

  it('recovers every advertised invocation from one DeepSeek DSML block', () => {
    const text = [
      '<|DSML|| tool_calls>',
      '<|DSML|| invoke name="bash">',
      '<|DSML|| parameter name="command" string="true">node --version</|DSML|| parameter>',
      '</|DSML|| invoke>',
      '<|DSML|| invoke name="bash">',
      '<|DSML|| parameter name="command" string="true">python3 --version</|DSML|| parameter>',
      '</|DSML|| invoke>',
      '</|DSML|| tool_calls>'
    ].join('\n')

    expect(recoverDsmlToolCalls(text, new Set(['bash']))).toEqual({
      calls: [
        { toolName: 'bash', arguments: { command: 'node --version' } },
        { toolName: 'bash', arguments: { command: 'python3 --version' } }
      ],
      visibleText: ''
    })
  })

  it('detects a raw DSML block even when the tool is not advertised', () => {
    // 典型泄漏场景：模型在 wrap-up 阶段工具列表被剥离后仍输出 DSML 调用。
    const text = [
      '<|DSML|| tool_calls>',
      '<|DSML|| invoke name="mcp_call">',
      '<|DSML|| parameter name="arguments" string="false">{"query":"生产销售假药罪"}</|DSML|| parameter>',
      '<|DSML|| parameter name="toolId" string="true">yuandian-law/yuandian_law_vector_search</|DSML|| parameter>',
      '</|DSML|| invoke>',
      '</|DSML|| tool_calls>'
    ].join('\n')

    expect(recoverDsmlToolCalls(text, new Set([]))).toBeNull()
    expect(looksLikeDsmlToolCalls(text)).toBe(true)
    // 剥离后应无任何残留 XML，也不会把工具调用当可见正文。
    expect(stripDsmlToolCalls(text)).toBe('')
  })

  it('strips DSML blocks but keeps real prose before them', () => {
    const text = [
      '第一阶段完成，现在进入案例检索。',
      '<|DSML|| tool_calls>',
      '<|DSML|| invoke name="yuandian-case/yuandian_case_vector_search">',
      '<|DSML|| parameter name="query" string="false">假药</|DSML|| parameter>',
      '</|DSML|| invoke>',
      '</|DSML|| tool_calls>'
    ].join('\n')

    expect(looksLikeDsmlToolCalls(text)).toBe(true)
    expect(stripDsmlToolCalls(text)).toBe('第一阶段完成，现在进入案例检索。')
  })
})

describe('DSML full-width and mixed-format stripping', () => {
  it('detects and strips the real leaked format with double vertical bars around DSML', () => {
    const text = [
      '我需要读取原文档剩余部分。',
      '<||DSML||tool_calls>',
      '<||DSML||invoke name="document_skill_execute">',
      '<||DSML||parameter name="kind" string="true">docx</||DSML||parameter>',
      '</||DSML||invoke>',
      '</||DSML||tool_calls>'
    ].join('\n')
    expect(looksLikeDsmlToolCalls(text)).toBe(true)
    expect(stripDsmlToolCalls(text)).toBe('我需要读取原文档剩余部分。')
  })

  it('detects and strips full-width vertical-bar variants', () => {
    const text = [
      '开始生成。',
      '<｜DSML｜｜tool_calls>',
      '<｜DSML｜｜invoke name="bash">',
      '<｜DSML｜｜parameter name="command" string="true">ls</｜DSML｜｜parameter>',
      '</｜DSML｜｜invoke>',
      '</｜DSML｜｜tool_calls>'
    ].join('\n')
    expect(looksLikeDsmlToolCalls(text)).toBe(true)
    expect(stripDsmlToolCalls(text)).toBe('开始生成。')
  })

  it('does not strip ordinary prose that merely mentions DSML', () => {
    const text = 'DSML 是一种序列化格式。'
    expect(looksLikeDsmlToolCalls(text)).toBe(false)
    expect(stripDsmlToolCalls(text)).toBe('DSML 是一种序列化格式。')
  })
})
