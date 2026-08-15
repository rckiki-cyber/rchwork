import { describe, it, expect } from 'vitest'
import { CapabilityRegistry } from './capability-registry.js'
import type { LocalTool } from './local-tool-host.js'
import type { ToolHostContext } from '../../ports/tool-host.js'

function tool(name: string): LocalTool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    toolKind: 'tool_call',
    policy: 'auto',
    execute: async () => ({ output: 'ok' })
  }
}

function baseContext(extra: Partial<ToolHostContext> = {}): ToolHostContext {
  return {
    threadId: 't',
    turnId: 'u',
    workspace: '/tmp',
    approvalPolicy: 'auto',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow',
    ...extra
  }
}

describe('CapabilityRegistry web-first scope（主对话优先 web_search、法律 MCP 兜底）', () => {
  it('webFirstMcpScope=true 时默认不注入任何 MCP 工具（含调度入口），只保留 web_search/基础工具', () => {
    const registry = new CapabilityRegistry([
      {
        id: 'builtin',
        kind: 'built-in',
        enabled: true,
        available: true,
        tools: [tool('read'), tool('web_search'), tool('web_fetch'), tool('mcp_search'), tool('mcp_call')]
      },
      {
        id: 'mcp',
        kind: 'mcp',
        enabled: true,
        available: true,
        tools: [tool('mcp_pkulaw_law_search_search'), tool('mcp_yuandian_law_query')]
      }
    ])
    const names = registry.listTools(baseContext({ webFirstMcpScope: true })).map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('web_search')
    expect(names).not.toContain('mcp_search')
    expect(names).not.toContain('mcp_call')
    expect(names).not.toContain('mcp_pkulaw_law_search_search')
    expect(names).not.toContain('mcp_yuandian_law_query')
  })

  it('webFirstMcpScope 未设置（undefined）时保持全量工具（专用工作流/默认行为不受影响）', () => {
    const registry = new CapabilityRegistry([
      {
        id: 'mcp',
        kind: 'mcp',
        enabled: true,
        available: true,
        tools: [tool('mcp_pkulaw_law_search_search'), tool('mcp_yuandian_law_query')]
      }
    ])
    const names = registry.listTools(baseContext()).map((t) => t.name)
    expect(names).toContain('mcp_pkulaw_law_search_search')
    expect(names).toContain('mcp_yuandian_law_query')
  })
})
