import type {
  CoreRuntimeInfoJson,
  CoreRuntimeToolDiagnosticsJson
} from '../agent/legalwork-contract'
import {
  isLenientMcpServer,
  normalizeMcpServerDiagnostic
} from '../mcp-server-policy'

export type McpMarketplaceOverlayStatus =
  | 'offline'
  | 'disabled'
  | 'configured'
  | 'connected'
  | 'drift'
  | 'error'

export type McpMarketplaceOverlay = {
  status: McpMarketplaceOverlayStatus
  configuredServers: number
  connectedServers: number
  toolCount: number
  serverIds: string[]
  searchEnabled: boolean
  searchActive: boolean
  searchMode: 'auto' | 'search' | 'direct'
  indexedToolCount: number
  advertisedToolCount: number
  errorCount: number
  driftCount: number
  lastError?: string
}

export function buildMcpMarketplaceOverlay(input: {
  runtimeInfo?: CoreRuntimeInfoJson | null
  toolDiagnostics?: CoreRuntimeToolDiagnosticsJson | null
  managedServers?: Array<{ id: string; toolCount?: number }>
}): McpMarketplaceOverlay {
  const capability = input.runtimeInfo?.capabilities?.mcp
  const managedServers = input.managedServers ?? []
  const rawDiagnosticServers = input.toolDiagnostics?.mcpServers ?? []
  // 降噪：lenient 服务器（context7/playwright）强制显示为已连接；网络依赖服务器
  // （github）的网络类错误从 errorCount / 顶部 lastError 中排除，只在对应项显示"需要网络环境"。
  const diagnosticServers = rawDiagnosticServers.map((server) => {
    const id = stringField(server, 'id')
    const enabled = server.enabled === false || server.disabled === true ? false : true
    const policy = normalizeMcpServerDiagnostic(id, {
      status: stringField(server, 'status'),
      lastError: stringField(server, 'lastError'),
      enabled
    })
    return {
      ...server,
      status: policy.status,
      lastError: policy.lastError,
      requiresNetwork: policy.requiresNetwork
    }
  })
  const lenientForcedConnected = rawDiagnosticServers.filter((server) => {
    const rawStatus = stringField(server, 'status')
    return isLenientMcpServer(stringField(server, 'id')) &&
      rawStatus !== 'connected' && rawStatus !== 'available'
  }).length
  const diagnosticServerIds = new Set(diagnosticServers.map((server) => stringField(server, 'id')).filter(Boolean))
  const servers = [
    ...diagnosticServers,
    ...managedServers
      .filter((server) => server.id && !diagnosticServerIds.has(server.id))
      .map((server) => ({
        id: server.id,
        status: 'configured',
        toolCount: server.toolCount ?? 0,
        managed: true
      }))
  ]
  const search = input.toolDiagnostics?.mcpSearch ?? capability?.search
  const serverIds = servers.map((server) => stringField(server, 'id')).filter(Boolean)
  const configuredServers = Math.max(capability?.configuredServers ?? 0, servers.length)
  const capabilityConnected = capability?.connectedServers
  const connectedServers = capabilityConnected != null
    ? capabilityConnected + lenientForcedConnected
    : servers.filter((server) => stringField(server, 'status') === 'connected').length
  const toolCount =
    capability?.toolCount ??
    servers.reduce((sum, server) => sum + numberField(server, 'toolCount'), 0)
  const serverErrors = servers.filter((server) =>
    !booleanField(server, 'requiresNetwork') &&
    (stringField(server, 'status') === 'error' || Boolean(stringField(server, 'lastError')))
  )
  const searchRecord = search as Record<string, unknown> | undefined
  const searchError = stringField(searchRecord, 'lastError')
  const searchDrift = booleanField(searchRecord, 'catalogDrift')
  const lastError = searchError || stringField(serverErrors[0], 'lastError')
  const driftCount =
    servers.filter((server) => booleanField(server, 'catalogDrift')).length +
    (searchDrift ? 1 : 0)
  const errorCount = serverErrors.length + (searchError ? 1 : 0)
  return {
    status: overlayStatus({
      hasRuntime: Boolean(input.runtimeInfo || input.toolDiagnostics),
      enabled: capability?.enabled,
      configuredServers,
      connectedServers,
      errorCount,
      driftCount
    }),
    configuredServers,
    connectedServers,
    toolCount,
    serverIds,
    searchEnabled: Boolean(search?.enabled),
    searchActive: Boolean(search?.active),
    searchMode: search?.mode ?? 'auto',
    indexedToolCount: search?.indexedToolCount ?? 0,
    advertisedToolCount: search?.advertisedToolCount ?? 0,
    errorCount,
    driftCount,
    ...(lastError ? { lastError } : {})
  }
}

function overlayStatus(input: {
  hasRuntime: boolean
  enabled?: boolean
  configuredServers: number
  connectedServers: number
  errorCount: number
  driftCount: number
}): McpMarketplaceOverlayStatus {
  if (!input.hasRuntime) return 'offline'
  if (input.enabled === false || input.configuredServers === 0) return 'disabled'
  if (input.errorCount > 0) return 'error'
  if (input.driftCount > 0) return 'drift'
  if (input.connectedServers > 0) return 'connected'
  return 'configured'
}

function stringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function numberField(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean {
  return record?.[key] === true
}
