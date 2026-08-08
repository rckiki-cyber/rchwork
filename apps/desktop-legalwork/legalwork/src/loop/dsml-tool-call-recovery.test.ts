import { describe, expect, it } from 'vitest'
import { recoverDsmlToolCall } from './dsml-tool-call-recovery.js'

describe('DSML tool-call recovery', () => {
  it('recovers the DeepSeek text form while preserving user-facing text', () => {
    const text = [
      'Word 已生成。现在生成 PDF。',
      '<｜｜DSML｜｜tool_calls>',
      '<｜｜DSML｜｜invoke name="mcp_search">',
      '<｜｜DSML｜｜parameter name="query" string="true">PDF 转换</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="topK" string="false">5</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜tool_calls>'
    ].join('\n')

    expect(recoverDsmlToolCall(text, new Set(['mcp_search']))).toEqual({
      toolName: 'mcp_search',
      arguments: { query: 'PDF 转换', topK: 5 },
      visibleText: 'Word 已生成。现在生成 PDF。'
    })
  })

  it('never recovers a tool that was not advertised in the request', () => {
    const text = '<｜｜DSML｜｜invoke name="bash"></｜｜DSML｜｜invoke>'
    expect(recoverDsmlToolCall(text, new Set(['mcp_search']))).toBeNull()
  })
})
