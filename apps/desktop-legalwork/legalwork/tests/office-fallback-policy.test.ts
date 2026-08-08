import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import {
  DOCUMENT_UNSUPPORTED_MARKER,
  REQUEST_OFFICE_FALLBACK_TOOL_NAME,
  createRequestOfficeFallbackTool
} from '../src/adapters/tool/builtin-office-fallback-tool.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import {
  LEGAL_DOCUMENT_FORMATTING_SKILL_ID,
  OFFICECLI_TOOL_NAME,
  clearOfficeFallbackGrant
} from '../src/adapters/tool/office-fallback-policy.js'

const ticketRoot = join(tmpdir(), 'legalwork-office-fallback')
const context = {
  threadId: 'thread-office-fallback',
  turnId: 'turn-office-fallback',
  workspace: tmpdir(),
  activeSkillIds: [LEGAL_DOCUMENT_FORMATTING_SKILL_ID],
  approvalPolicy: 'auto' as const,
  abortSignal: new AbortController().signal,
  awaitApproval: async () => 'allow' as const
}

afterEach(async () => {
  clearOfficeFallbackGrant(context)
  await rm(ticketRoot, { recursive: true, force: true })
})

describe('Office fallback policy', () => {
  it('hides and blocks OfficeCLI before a fallback grant', async () => {
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

    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual([
      REQUEST_OFFICE_FALLBACK_TOOL_NAME
    ])
    await expect(host.execute({
      callId: 'office-before-grant',
      toolName: OFFICECLI_TOOL_NAME,
      providerId: 'mcp:officecli',
      arguments: {}
    }, context)).rejects.toThrow(/active tool policy/)
  })

  it('rejects environment/dependency unsupported tickets without structural evidence', async () => {
    await mkdir(ticketRoot, { recursive: true })
    const ticket = join(ticketRoot, 'ticket-runtime-error.json')
    await writeFile(ticket, JSON.stringify({
      marker: DOCUMENT_UNSUPPORTED_MARKER,
      status: 'unsupported',
      source: 'legal-document-formatting',
      operation: 'normalize',
      reason: 'python-docx unavailable: import failed',
      detail: null,
      created_at: new Date().toISOString()
    }), 'utf8')

    const fallback = createRequestOfficeFallbackTool()
    const host = new LocalToolHost({ registry: CapabilityRegistry.fromLocalTools([fallback]) })
    const result = await host.execute({
      callId: 'fallback-runtime-error',
      toolName: REQUEST_OFFICE_FALLBACK_TOOL_NAME,
      providerId: 'builtin',
      arguments: { ticket }
    }, context)

    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind === 'tool_result') {
      expect(result.item.isError).toBe(true)
      expect(result.item.output).toMatchObject({
        error: expect.stringMatching(/document-structure limitation/)
      })
    }
  })

  it('accepts a structurally evidenced worker ticket once and exposes OfficeCLI only for that turn', async () => {
    await mkdir(ticketRoot, { recursive: true })
    const ticket = join(ticketRoot, 'ticket-test.json')
    await writeFile(ticket, JSON.stringify({
      marker: DOCUMENT_UNSUPPORTED_MARKER,
      status: 'unsupported',
      source: 'legal-document-formatting',
      operation: 'normalize',
      reason: 'tracked changes require a richer editor',
      detail: { tracked_changes: true, macros: false },
      created_at: new Date().toISOString()
    }), 'utf8')

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
      arguments: { ticket }
    }, context)

    expect(granted.item.kind).toBe('tool_result')
    if (granted.item.kind === 'tool_result') {
      expect(granted.item.isError).not.toBe(true)
      expect(granted.item.output).toMatchObject({ granted: true, scope: 'turn' })
    }
    expect((await host.listTools(context)).map((tool) => tool.name).sort()).toEqual([
      OFFICECLI_TOOL_NAME,
      REQUEST_OFFICE_FALLBACK_TOOL_NAME
    ].sort())

    const otherTurn = { ...context, turnId: 'turn-other' }
    expect((await host.listTools(otherTurn)).map((tool) => tool.name)).toEqual([
      REQUEST_OFFICE_FALLBACK_TOOL_NAME
    ])
  })
})
