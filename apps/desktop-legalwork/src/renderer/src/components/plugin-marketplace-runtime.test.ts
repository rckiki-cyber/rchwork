import { describe, expect, it } from 'vitest'

import { buildMcpMarketplaceOverlay } from './plugin-marketplace-runtime'

describe('buildMcpMarketplaceOverlay', () => {
  it('summarizes connected MCP runtime state', () => {
    const overlay = buildMcpMarketplaceOverlay({
      runtimeInfo: {
        host: '127.0.0.1',
        port: 8899,
        dataDir: '/tmp/legalwork',
        startedAt: '2026-06-03T00:00:00.000Z',
        capabilities: {
          contractVersion: 1,
          model: {
            id: 'deepseek-chat',
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsToolCalling: true,
            messageParts: ['text']
          },
          cli: {
            serve: { status: 'available', enabled: true, available: true },
            run: { status: 'disabled', enabled: false, available: false },
            chat: { status: 'disabled', enabled: false, available: false },
            exec: { status: 'disabled', enabled: false, available: false }
          },
          mcp: {
            status: 'available',
            enabled: true,
            available: true,
            configuredServers: 2,
            connectedServers: 1,
            toolCount: 12,
            search: {
              enabled: true,
              mode: 'auto',
              active: true,
              indexedToolCount: 12,
              advertisedToolCount: 3
            }
          },
          web: {
            status: 'disabled',
            enabled: false,
            available: false,
            fetch: { status: 'disabled', enabled: false, available: false },
            search: { status: 'disabled', enabled: false, available: false }
          },
          skills: { status: 'disabled', enabled: false, available: false, configuredRoots: 0, discoveredSkills: 0 },
          subagents: { status: 'disabled', enabled: false, available: false, maxParallel: 0, maxChildRuns: 0 },
          attachments: {
            status: 'disabled',
            enabled: false,
            available: false,
            maxImageBytes: 1,
            maxImageDimension: 1,
            allowedMimeTypes: []
          },
          memory: { status: 'disabled', enabled: false, available: false, scopes: ['user'], maxInjectedRecords: 1 }
        }
      },
      toolDiagnostics: {
        mcpServers: [
          { id: 'github', status: 'connected', toolCount: 12 },
          { id: 'local', status: 'disabled', toolCount: 0 }
        ],
        mcpSearch: {
          enabled: true,
          mode: 'auto',
          active: true,
          indexedToolCount: 12,
          advertisedToolCount: 3
        }
      }
    })

    expect(overlay).toMatchObject({
      status: 'connected',
      configuredServers: 2,
      connectedServers: 1,
      toolCount: 12,
      serverIds: ['github', 'local'],
      searchActive: true,
      indexedToolCount: 12,
      advertisedToolCount: 3
    })
  })

  it('prioritizes error and drift diagnostics', () => {
    expect(buildMcpMarketplaceOverlay({
      toolDiagnostics: {
        mcpServers: [{ id: 'bad', status: 'error', lastError: 'missing token' }]
      }
    })).toMatchObject({
      status: 'error',
      errorCount: 1,
      lastError: 'missing token'
    })

    expect(buildMcpMarketplaceOverlay({
      toolDiagnostics: {
        mcpServers: [{ id: 'docs', status: 'connected', catalogDrift: true, toolCount: 5 }]
      }
    })).toMatchObject({
      status: 'drift',
      driftCount: 1
    })
  })

  it('reports disabled and offline states', () => {
    expect(buildMcpMarketplaceOverlay({
      runtimeInfo: {
        host: '127.0.0.1',
        port: 8899,
        dataDir: '/tmp/legalwork',
        startedAt: '2026-06-03T00:00:00.000Z',
        capabilities: {
          contractVersion: 1,
          model: {
            id: 'deepseek-chat',
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsToolCalling: true,
            messageParts: ['text']
          },
          cli: {
            serve: { status: 'available', enabled: true, available: true },
            run: { status: 'disabled', enabled: false, available: false },
            chat: { status: 'disabled', enabled: false, available: false },
            exec: { status: 'disabled', enabled: false, available: false }
          },
          mcp: {
            status: 'disabled',
            enabled: false,
            available: false,
            configuredServers: 0,
            connectedServers: 0,
            toolCount: 0
          },
          web: {
            status: 'disabled',
            enabled: false,
            available: false,
            fetch: { status: 'disabled', enabled: false, available: false },
            search: { status: 'disabled', enabled: false, available: false }
          },
          skills: { status: 'disabled', enabled: false, available: false, configuredRoots: 0, discoveredSkills: 0 },
          subagents: { status: 'disabled', enabled: false, available: false, maxParallel: 0, maxChildRuns: 0 },
          attachments: {
            status: 'disabled',
            enabled: false,
            available: false,
            maxImageBytes: 1,
            maxImageDimension: 1,
            allowedMimeTypes: []
          },
          memory: { status: 'disabled', enabled: false, available: false, scopes: ['user'], maxInjectedRecords: 1 }
        }
      }
    }).status).toBe('disabled')

    expect(buildMcpMarketplaceOverlay({}).status).toBe('offline')
  })

  it('includes GUI-managed MCP servers before runtime diagnostics connect', () => {
    expect(buildMcpMarketplaceOverlay({
      managedServers: [{ id: 'legalwork_schedule', toolCount: 4 }]
    })).toMatchObject({
      status: 'offline',
      configuredServers: 1,
      toolCount: 4,
      serverIds: ['legalwork_schedule']
    })
  })
})

describe('buildMcpMarketplaceOverlay denoising', () => {
  const capabilityWithConnected = (connected: number) => ({
    mcp: {
      enabled: true,
      configuredServers: 4,
      connectedServers: connected,
      toolCount: 30
    }
  })

  it('shows lenient servers (context7/playwright) as connected and excludes their errors', () => {
    const overlay = buildMcpMarketplaceOverlay({
      runtimeInfo: { capabilities: capabilityWithConnected(1) } as never,
      toolDiagnostics: {
        mcpServers: [
          { id: 'filesystem', status: 'connected', toolCount: 14 },
          { id: 'context7', status: 'error', lastError: 'MCP error -32001: Request timed out' },
          { id: 'playwright', status: 'error', lastError: 'MCP error -32001: Request timed out' }
        ]
      } as never
    })

    expect(overlay).toMatchObject({
      status: 'connected',
      configuredServers: 4,
      connectedServers: 3,
      errorCount: 0,
      serverIds: ['filesystem', 'context7', 'playwright']
    })
    expect(overlay.lastError).toBeUndefined()
  })

  it('excludes a github network error from errorCount and lastError', () => {
    const overlay = buildMcpMarketplaceOverlay({
      runtimeInfo: { capabilities: capabilityWithConnected(2) } as never,
      toolDiagnostics: {
        mcpServers: [
          { id: 'filesystem', status: 'connected', toolCount: 14 },
          { id: 'github', status: 'error', lastError: 'MCP error -32001: Request timed out' }
        ]
      } as never
    })

    expect(overlay).toMatchObject({
      status: 'connected',
      errorCount: 0,
      connectedServers: 2
    })
    expect(overlay.lastError).toBeUndefined()
  })

  it('keeps a github auth error as a real error', () => {
    const overlay = buildMcpMarketplaceOverlay({
      runtimeInfo: { capabilities: capabilityWithConnected(2) } as never,
      toolDiagnostics: {
        mcpServers: [
          { id: 'github', status: 'error', lastError: 'HTTP 401 unauthorized' }
        ]
      } as never
    })

    expect(overlay).toMatchObject({
      status: 'error',
      errorCount: 1,
      lastError: 'HTTP 401 unauthorized'
    })
  })

  it('falls back to the normalized list when capability counts are absent', () => {
    const overlay = buildMcpMarketplaceOverlay({
      toolDiagnostics: {
        mcpServers: [
          { id: 'filesystem', status: 'connected', toolCount: 14 },
          { id: 'playwright', status: 'error', lastError: 'timed out' }
        ]
      } as never
    })

    expect(overlay).toMatchObject({
      status: 'connected',
      configuredServers: 2,
      connectedServers: 2,
      errorCount: 0
    })
  })
})
