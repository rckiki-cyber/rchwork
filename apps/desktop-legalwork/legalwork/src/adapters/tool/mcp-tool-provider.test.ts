import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpCapabilityConfig } from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import {
  buildMcpToolProviders,
  normalizeOfficeCliArguments,
  type McpClientLike
} from './mcp-tool-provider.js'

function fakeClient(): McpClientLike {
  return {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({}),
    close: async () => undefined
  }
}

function mcpConfig(serverId = 'officecli'): McpCapabilityConfig {
  return {
    enabled: true,
    servers: {
      [serverId]: {
        enabled: true,
        transport: 'stdio',
        command: 'fake-mcp',
        args: [],
        headers: {},
        env: {},
        trustScope: 'user',
        trustedWorkspaceRoots: [],
        timeoutMs: 30_000
      }
    },
    search: {
      enabled: false,
      mode: 'direct',
      autoThresholdToolCount: 24,
      topKDefault: 5,
      topKMax: 10,
      minScore: 0.15,
      bm25: { k1: 1.2, b: 0.75 }
    }
  }
}

function toolContext(threadId = 'thread-officecli'): ToolHostContext {
  return {
    threadId,
    turnId: 'turn-officecli',
    workspace: '/tmp/workspace',
    approvalPolicy: 'auto',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

describe('buildMcpToolProviders', () => {
  it('connects MCP servers in parallel during startup', async () => {
    let started = 0
    let releaseFirst: (() => void) | undefined
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const config: McpCapabilityConfig = {
      enabled: true,
      servers: {
        first: {
          enabled: true,
          transport: 'streamable-http',
          url: 'https://mcp.example.test/first',
          headers: {},
          env: {},
          args: [],
          trustScope: 'user',
          trustedWorkspaceRoots: [],
          timeoutMs: 30000
        },
        second: {
          enabled: true,
          transport: 'streamable-http',
          url: 'https://mcp.example.test/second',
          headers: {},
          env: {},
          args: [],
          trustScope: 'user',
          trustedWorkspaceRoots: [],
          timeoutMs: 30000
        }
      },
      search: {
        enabled: false,
        mode: 'auto',
        autoThresholdToolCount: 24,
        topKDefault: 5,
        topKMax: 10,
        minScore: 0.15,
        bm25: { k1: 1.2, b: 0.75 }
      }
    }

    await expect(Promise.race([
      buildMcpToolProviders(config, {
        clientFactory: async (serverId) => {
          started += 1
          if (serverId === 'first') await firstStarted
          if (serverId === 'second') releaseFirst?.()
          return fakeClient()
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MCP startup stayed serial')), 250))
    ])).resolves.toMatchObject({
      connectedServers: 2
    })
    expect(started).toBe(2)
  })

  it('uses the startup timeout cap while building initial MCP clients', async () => {
    const seenTimeouts: number[] = []
    const config: McpCapabilityConfig = {
      enabled: true,
      servers: {
        slow: {
          enabled: true,
          transport: 'streamable-http',
          url: 'https://mcp.example.test/slow',
          headers: {},
          env: {},
          args: [],
          trustScope: 'user',
          trustedWorkspaceRoots: [],
          timeoutMs: 30000
        }
      },
      search: {
        enabled: false,
        mode: 'auto',
        autoThresholdToolCount: 24,
        topKDefault: 5,
        topKMax: 10,
        minScore: 0.15,
        bm25: { k1: 1.2, b: 0.75 }
      }
    }

    await buildMcpToolProviders(config, {
      startupTimeoutMs: 4000,
      clientFactory: async (_serverId, server) => {
        seenTimeouts.push(server.timeoutMs)
        return fakeClient()
      }
    })

    expect(seenTimeouts).toEqual([4000])
  })

  it('gives stdio MCP servers a longer startup timeout to survive npx cold-start', async () => {
    const seenTimeouts: number[] = []
    const config: McpCapabilityConfig = {
      enabled: true,
      servers: {
        context7: {
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@latest'],
          headers: {},
          env: {},
          trustScope: 'user',
          trustedWorkspaceRoots: [],
          timeoutMs: 8_000
        }
      },
      search: {
        enabled: false,
        mode: 'auto',
        autoThresholdToolCount: 24,
        topKDefault: 5,
        topKMax: 10,
        minScore: 0.15,
        bm25: { k1: 1.2, b: 0.75 }
      }
    }

    await buildMcpToolProviders(config, {
      startupTimeoutMs: 8_000,
      clientFactory: async (_serverId, server) => {
        seenTimeouts.push(server.timeoutMs)
        return fakeClient()
      }
    })

    expect(seenTimeouts).toEqual([60_000])
  })

  it('uses Flint static rendering automatically and persists image artifacts', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'legalwork-flint-chart-'))
    const png = Buffer.from('fake-png')
    const client: McpClientLike = {
      listTools: async () => ({
        tools: [
          {
            name: 'create_chart_view',
            inputSchema: { type: 'object' },
            _meta: { ui: { resourceUri: 'ui://flint-chart/chart-view.html' } }
          },
          {
            name: 'render_chart',
            inputSchema: { type: 'object' }
          }
        ]
      }),
      callTool: async () => ({
        content: [
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: 'vegalite · png · 400×300px' }
        ]
      }),
      close: async () => undefined
    }

    try {
      const built = await buildMcpToolProviders(mcpConfig('flint-chart'), {
        clientFactory: async () => client
      })
      const tools = built.providers[0]?.tools ?? []
      expect(tools.map((tool) => tool.name)).toEqual(['mcp_flint_chart_render_chart'])
      expect(tools[0]?.policy).toBe('auto')

      const rendered = await tools[0]!.execute(
        {},
        { ...toolContext('thread-flint'), workspace: tempRoot }
      )
      const output = rendered.output as {
        file_path: string
        artifacts: string[]
        result: { content: Array<{ type: string; text: string }> }
      }
      expect(output.artifacts).toEqual([output.file_path])
      expect(existsSync(output.file_path)).toBe(true)
      expect(readFileSync(output.file_path)).toEqual(png)
      expect(JSON.stringify(output.result)).not.toContain(png.toString('base64'))
      expect(output.result.content[0]?.text).toContain(output.file_path)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rebuilds split OfficeCLI add arguments with the active task document', async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const client: McpClientLike = {
      listTools: async () => ({
        tools: [{
          name: 'officecli',
          inputSchema: {
            type: 'object',
            properties: { command: { type: ['string', 'array'] } },
            required: ['command']
          }
        }]
      }),
      callTool: async (input) => {
        calls.push(input)
        return { isError: false }
      },
      close: async () => undefined
    }
    const built = await buildMcpToolProviders(mcpConfig(), {
      clientFactory: async () => client
    })
    const tool = built.providers[0]?.tools[0]
    if (!tool) throw new Error('OfficeCLI tool was not built')
    const file = '/tmp/案件材料/民事答辩状.docx'

    await tool.execute({ command: ['open', file] }, toolContext())
    await tool.execute({
      command: 'add',
      parent: '/body',
      type: 'paragraph',
      props: {
        text: '答辩人：赤峰兴业建筑有限公司',
        bold: true
      }
    }, toolContext())

    expect(tool.inputSchema).toMatchObject({ additionalProperties: false })
    expect(calls[1]).toEqual({
      name: 'officecli',
      arguments: {
        command: [
          'add',
          file,
          '/body',
          '--type',
          'paragraph',
          '--prop',
          'text=答辩人：赤峰兴业建筑有限公司',
          '--prop',
          'bold=true'
        ]
      }
    })
  })
})

describe('normalizeOfficeCliArguments', () => {
  it('repairs a JSON-stringified argv array emitted by the model', () => {
    expect(normalizeOfficeCliArguments({
      command: '["open","/tmp/民事答辩状.docx"]'
    })).toEqual({
      arguments: { command: ['open', '/tmp/民事答辩状.docx'] }
    })
  })

  it('returns a concise retryable error instead of executing a bare add', () => {
    expect(normalizeOfficeCliArguments({
      command: 'add',
      parent: '/body',
      type: 'paragraph'
    })).toMatchObject({
      error: expect.stringContaining('no active document')
    })
  })
})
