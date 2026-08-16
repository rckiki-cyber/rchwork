import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  McpSearchConfig,
  McpServerConfig
} from '../src/contracts/capabilities.js'
import { createMcpSearchProvider } from '../src/adapters/tool/mcp-tool-search.js'
import type {
  McpSearchCatalogRecord,
  McpSearchClientLike
} from '../src/adapters/tool/mcp-tool-search.js'
import {
  clearOfficeFallbackGrant,
  grantOfficeFallback,
  LEGAL_DOCUMENT_FORMATTING_SKILL_ID,
  OFFICECLI_TOOL_NAME
} from '../src/adapters/tool/office-fallback-policy.js'

const context = {
  threadId: 'thread-mcp-office-gate',
  turnId: 'turn-mcp-office-gate',
  workspace: '/tmp',
  activeSkillIds: [LEGAL_DOCUMENT_FORMATTING_SKILL_ID],
  approvalPolicy: 'auto' as const,
  abortSignal: new AbortController().signal,
  awaitApproval: async () => 'allow' as const
}

function server() {
  return McpServerConfig.parse({
    enabled: true,
    transport: 'stdio',
    command: 'node',
    args: [],
    trustScope: 'user'
  })
}

function record(input: {
  serverId: string
  toolName: string
  normalizedName: string
  callTool: McpSearchClientLike['callTool']
}): McpSearchCatalogRecord {
  return {
    toolId: `${input.serverId}/${input.toolName}`,
    serverId: input.serverId,
    server: server(),
    client: { callTool: input.callTool },
    descriptor: {
      name: input.toolName,
      description: `${input.serverId} ${input.toolName} document tool`,
      inputSchema: { type: 'object', properties: {} }
    },
    normalizedName: input.normalizedName,
    policy: 'auto' as const
  }
}

afterEach(() => {
  clearOfficeFallbackGrant(context)
})

describe('Office fallback gate in MCP search mode', () => {
  it('filters OfficeCLI from search, describe, and dynamic calls until the turn is granted', async () => {
    const officeCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const legalCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'legal' }] }))
    const state = {
      records: [
        record({
          serverId: 'officecli',
          toolName: 'officecli',
          normalizedName: OFFICECLI_TOOL_NAME,
          callTool: officeCall
        }),
        record({
          serverId: 'pkulaw-search',
          toolName: 'search',
          normalizedName: 'mcp_pkulaw_search_search',
          callTool: legalCall
        })
      ]
    }
    const provider = createMcpSearchProvider({
      config: McpSearchConfig.parse({ enabled: true, mode: 'search', minScore: 0 }),
      state,
      refreshCatalog: async () => state.records,
      isServerTrusted: () => true
    })
    const byName = (name: string) => {
      const tool = provider.tools.find((candidate) => candidate.name === name)
      if (!tool) throw new Error(`missing tool: ${name}`)
      return tool
    }

    const searchBefore = await byName('mcp_search').execute({ query: 'office document', topK: 10 }, context)
    expect(searchBefore.output).toMatchObject({ searchedTools: 1 })
    expect(JSON.stringify(searchBefore.output)).not.toContain('officecli')

    const describeBefore = await byName('mcp_describe').execute({ toolId: 'officecli/officecli' }, context)
    expect(describeBefore.isError).toBe(true)
    expect(describeBefore.output).toMatchObject({ error: expect.stringContaining('unknown MCP tool: officecli/officecli') })

    const callBefore = await byName('mcp_call').execute({
      toolId: 'officecli/officecli',
      arguments: {}
    }, context)
    expect(callBefore.isError).toBe(true)
    expect(officeCall).not.toHaveBeenCalled()

    grantOfficeFallback(context)

    const searchAfter = await byName('mcp_search').execute({ query: 'office document', topK: 10 }, context)
    expect(searchAfter.output).toMatchObject({ searchedTools: 2 })

    const describeAfter = await byName('mcp_describe').execute({ toolId: 'officecli/officecli' }, context)
    expect(describeAfter.isError).not.toBe(true)
    expect(describeAfter.output).toMatchObject({ serverId: 'officecli', toolName: 'officecli' })

    const callAfter = await byName('mcp_call').execute({
      toolId: 'officecli/officecli',
      arguments: { command: 'validate' }
    }, context)
    expect(callAfter.isError).not.toBe(true)
    expect(officeCall).toHaveBeenCalledTimes(1)
  })
})
