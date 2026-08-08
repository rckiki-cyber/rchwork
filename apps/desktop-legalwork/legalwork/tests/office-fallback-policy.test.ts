import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import {
  REQUEST_OFFICE_FALLBACK_TOOL_NAME,
  createRequestOfficeFallbackTool
} from '../src/adapters/tool/builtin-office-fallback-tool.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import {
  LEGAL_DOCUMENT_FORMATTING_SKILL_ID,
  OFFICECLI_TOOL_NAME,
  clearOfficeFallbackGrant,
  markOfficeFallbackEligible
} from '../src/adapters/tool/office-fallback-policy.js'

const context = {
  threadId: 'thread-office-fallback',
  turnId: 'turn-office-fallback',
  workspace: tmpdir(),
  activeSkillIds: [LEGAL_DOCUMENT_FORMATTING_SKILL_ID],
  approvalPolicy: 'auto' as const,
  abortSignal: new AbortController().signal,
  awaitApproval: async () => 'allow' as const
}

afterEach(() => {
  clearOfficeFallbackGrant(context)
})

describe('Office fallback policy', () => {
  it('hides and blocks both fallback request and OfficeCLI before local exhaustion', async () => {
    const office = LocalToolHost.defineTool({
      name: OFFICECLI_TOOL_NAME,
      description: 'office',
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const fallback = createRequestOfficeFallbackTool()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry([
        { id: 'builtin', kind: 'built-in', enabled: true, available: true, tools: [fallback] },
        { id: 'mcp:officecli', kind: 'mcp', enabled: true, available: true, tools: [office] }
      ])
    })

    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual([])
    await expect(host.execute({
      callId: 'fallback-before-eligible',
      toolName: REQUEST_OFFICE_FALLBACK_TOOL_NAME,
      providerId: 'builtin',
      arguments: {}
    }, context)).rejects.toThrow(/active tool policy/)
    await expect(host.execute({
      callId: 'office-before-grant',
      toolName: OFFICECLI_TOOL_NAME,
      providerId: 'mcp:officecli',
      arguments: {}
    }, context)).rejects.toThrow(/active tool policy/)
  })

  it('shows the fallback request only after runtime-recorded structural exhaustion', async () => {
    const fallback = createRequestOfficeFallbackTool()
    const host = new LocalToolHost({ registry: CapabilityRegistry.fromLocalTools([fallback]) })
    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual([])

    markOfficeFallbackEligible(context, {
      operation: 'normalize',
      reason: 'tracked changes require a preservation-safe editor'
    })
    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual([
      REQUEST_OFFICE_FALLBACK_TOOL_NAME
    ])
  })

  it('consumes runtime eligibility once and exposes OfficeCLI only for that turn', async () => {
    markOfficeFallbackEligible(context, {
      operation: 'normalize',
      reason: 'tracked changes require a preservation-safe editor'
    })

    const office = LocalToolHost.defineTool({
      name: OFFICECLI_TOOL_NAME,
      description: 'office',
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const fallback = createRequestOfficeFallbackTool()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry([
        { id: 'builtin', kind: 'built-in', enabled: true, available: true, tools: [fallback] },
        { id: 'mcp:officecli', kind: 'mcp', enabled: true, available: true, tools: [office] }
      ])
    })

    const granted = await host.execute({
      callId: 'fallback-request',
      toolName: REQUEST_OFFICE_FALLBACK_TOOL_NAME,
      providerId: 'builtin',
      arguments: {}
    }, context)

    expect(granted.item.kind).toBe('tool_result')
    if (granted.item.kind === 'tool_result') {
      expect(granted.item.isError).not.toBe(true)
      expect(granted.item.output).toMatchObject({ granted: true, scope: 'turn' })
    }
    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual([
      OFFICECLI_TOOL_NAME
    ])

    const otherTurn = { ...context, turnId: 'turn-other' }
    expect((await host.listTools(otherTurn)).map((tool) => tool.name)).toEqual([])
  })
})
