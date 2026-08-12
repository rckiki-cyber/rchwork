import { describe, expect, it, vi } from 'vitest'
import {
  isChatAttachmentUploadEnabled,
  resolveChatAttachmentCapabilities
} from './attachment-upload-availability'

const attachmentCapabilities = {
  status: 'available' as const,
  enabled: true,
  available: true,
  maxImageBytes: 5 * 1024 * 1024,
  maxImageDimension: 4096,
  allowedMimeTypes: ['*/*']
}

const runtimeInfo = {
  host: '127.0.0.1',
  port: 8900,
  dataDir: '/tmp/legalwork',
  startedAt: '2026-08-12T00:00:00.000Z',
  capabilities: {
    contractVersion: 1 as const,
    model: {
      id: 'fake',
      contextWindowTokens: 1_000_000,
      inputModalities: ['text' as const],
      outputModalities: ['text' as const],
      supportsToolCalling: true,
      messageParts: ['text' as const]
    },
    cli: {
      serve: { status: 'available' as const, enabled: true, available: true },
      run: { status: 'available' as const, enabled: true, available: true },
      chat: { status: 'available' as const, enabled: true, available: true },
      exec: { status: 'available' as const, enabled: true, available: true }
    },
    mcp: {
      status: 'disabled' as const,
      enabled: false,
      available: false,
      configuredServers: 0,
      connectedServers: 0,
      toolCount: 0
    },
    web: {
      status: 'disabled' as const,
      enabled: false,
      available: false,
      fetch: { status: 'disabled' as const, enabled: false, available: false },
      search: { status: 'disabled' as const, enabled: false, available: false }
    },
    skills: {
      status: 'disabled' as const,
      enabled: false,
      available: false,
      configuredRoots: 0,
      discoveredSkills: 0
    },
    subagents: {
      status: 'disabled' as const,
      enabled: false,
      available: false,
      maxParallel: 0,
      maxChildRuns: 0
    },
    attachments: attachmentCapabilities,
    memory: {
      status: 'disabled' as const,
      enabled: false,
      available: false,
      scopes: [],
      maxInjectedRecords: 8
    }
  }
}

describe('isChatAttachmentUploadEnabled', () => {
  it('enables composer attachments in chat when the Legalwork attachment store is ready', () => {
    expect(isChatAttachmentUploadEnabled({
      runtimeConnection: 'ready',
      route: 'chat',
      mode: 'agent',
      attachmentStoreAvailable: true
    })).toBe(true)
    expect(isChatAttachmentUploadEnabled({
      runtimeConnection: 'ready',
      route: 'chat',
      mode: 'plan',
      attachmentStoreAvailable: true
    })).toBe(true)
  })

  it('keeps the file picker visible while startup capability discovery is still unknown', () => {
    expect(isChatAttachmentUploadEnabled({
      runtimeConnection: 'ready',
      route: 'chat',
      mode: 'agent'
    })).toBe(true)
  })

  it('honors an explicit unavailable attachment store result', () => {
    expect(isChatAttachmentUploadEnabled({
      runtimeConnection: 'ready',
      route: 'chat',
      mode: 'agent',
      attachmentStoreAvailable: false
    })).toBe(false)
  })

  it('refreshes attachment capabilities on demand after the startup probe timed out', async () => {
    const loadRuntimeInfo = vi.fn(async () => runtimeInfo)

    await expect(resolveChatAttachmentCapabilities({ loadRuntimeInfo })).resolves.toEqual({
      capabilities: attachmentCapabilities,
      runtimeInfo
    })
    expect(loadRuntimeInfo).toHaveBeenCalledOnce()
  })

  it('reuses a confirmed cached capability without another runtime request', async () => {
    const loadRuntimeInfo = vi.fn(async () => runtimeInfo)

    await expect(resolveChatAttachmentCapabilities({
      cached: attachmentCapabilities,
      loadRuntimeInfo
    })).resolves.toEqual({ capabilities: attachmentCapabilities })
    expect(loadRuntimeInfo).not.toHaveBeenCalled()
  })

  it('disables composer attachments outside ready chat mode', () => {
    expect(isChatAttachmentUploadEnabled({
      runtimeConnection: 'connecting',
      route: 'chat',
      mode: 'agent',
      attachmentStoreAvailable: true
    })).toBe(false)
    expect(isChatAttachmentUploadEnabled({
      runtimeConnection: 'ready',
      route: 'write',
      mode: 'agent',
      attachmentStoreAvailable: true
    })).toBe(false)
  })
})
