import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  McpCapabilityConfig,
  McpServerConfig
} from '../../contracts/capabilities.js'
import { REDACTED_SECRET, redactSecretText } from '../../config/secret-redaction.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import {
  createMcpSearchProvider,
  mcpSearchDiagnostic,
  type McpSearchCatalogRecord,
  type McpSearchCatalogState,
  type McpSearchRuntimeDiagnostic
} from './mcp-tool-search.js'
import {
  createPkulawConnectionCandidates,
  resolveBundledPkulawToken
} from './pkulaw-fallback-auth.js'

export type McpToolDescriptor = {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  execution?: unknown
  icons?: unknown
  _meta?: Record<string, unknown>
}

export type McpClientLike = {
  listTools(options?: {
    cursor?: string
    signal?: AbortSignal
    timeout?: number
  }): Promise<{ tools: McpToolDescriptor[]; nextCursor?: string }>
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    options?: { signal?: AbortSignal; timeout?: number }
  ): Promise<unknown>
  close(): Promise<void>
}

export type McpServerDiagnostic = {
  id: string
  enabled: boolean
  transport: McpServerConfig['transport']
  trustScope: McpServerConfig['trustScope']
  available: boolean
  status: 'disabled' | 'connecting' | 'connected' | 'error'
  toolCount: number
  catalogFingerprint?: string
  catalogDrift?: boolean
  lastConnectedAt?: string
  lastError?: string
}

export type McpToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  diagnostics: McpServerDiagnostic[]
  search: McpSearchRuntimeDiagnostic
  connectedServers: number
  toolCount: number
  close: () => Promise<void>
}

export type McpToolProviderOptions = {
  clientFactory?: (serverId: string, server: McpServerConfig) => Promise<McpClientLike>
  nowIso?: () => string
  startupTimeoutMs?: number
  resolvePkulawFallbackToken?: () => string | undefined
  onServerSettled?: (input: {
    serverId: string
    provider?: CapabilityToolProvider
    diagnostic: McpServerDiagnostic
  }) => Promise<void> | void
}

type McpConnectionState = {
  serverId: string
  server: McpServerConfig
  connectionCandidates: McpServerConfig[]
  activeCandidateIndex: number
  client: McpClientLike
  clientFactory: (serverId: string, server: McpServerConfig) => Promise<McpClientLike>
  nowIso: () => string
  catalogFingerprint?: string
  catalogDrift?: boolean
  lastConnectedAt?: string
  lastError?: string
}

type McpServerBuildOutcome = {
  directProvider?: CapabilityToolProvider
  diagnostic: McpServerDiagnostic
  state?: McpConnectionState
  catalogRecords?: McpSearchCatalogRecord[]
}

const MCP_STARTUP_TIMEOUT_MS = 30_000
const STDIO_STARTUP_TIMEOUT_MS = 60_000
const COMMON_EXEC_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
const FLINT_CHART_SERVER_IDS = new Set(['flint-chart', 'flint_chart'])

export function pendingMcpToolProviders(
  config: McpCapabilityConfig | undefined
): McpToolProviderBuildResult {
  const searchConfig = config?.search ?? {
    enabled: false,
    mode: 'auto' as const,
    autoThresholdToolCount: 24,
    topKDefault: 5,
    topKMax: 10,
    minScore: 0.15,
    bm25: { k1: 1.2, b: 0.75 }
  }
  const diagnostics = Object.entries(config?.servers ?? {}).map(([serverId, server]) => {
    const effectivelyEnabled = server.enabled && (config?.enabled !== false)
    return serverDiagnostic(
      { serverId, server: { ...server, enabled: effectivelyEnabled } },
      effectivelyEnabled ? 'connecting' : 'disabled',
      0
    )
  })
  return {
    providers: [],
    diagnostics,
    search: mcpSearchDiagnostic({
      config: searchConfig,
      active: false,
      indexedToolCount: 0,
      advertisedToolCount: 0,
      state: { records: [] }
    }),
    connectedServers: 0,
    toolCount: 0,
    close: async () => undefined
  }
}

export async function buildMcpToolProviders(
  config: McpCapabilityConfig | undefined,
  options: McpToolProviderOptions = {}
): Promise<McpToolProviderBuildResult> {
  const providers: CapabilityToolProvider[] = []
  const directProviders: CapabilityToolProvider[] = []
  const diagnostics: McpServerDiagnostic[] = []
  const connected: McpConnectionState[] = []
  const catalogState: McpSearchCatalogState = { records: [] }
  const mcp = config
  const nowIso = options.nowIso ?? (() => new Date().toISOString())
  const clientFactory = options.clientFactory ?? createSdkMcpClient
  const startupTimeoutMs = options.startupTimeoutMs ?? MCP_STARTUP_TIMEOUT_MS
  if (!mcp?.enabled) {
    return {
      providers,
      diagnostics,
      search: mcpSearchDiagnostic({
        config: config?.search ?? {
          enabled: false,
          mode: 'auto',
          autoThresholdToolCount: 24,
          topKDefault: 5,
          topKMax: 10,
          minScore: 0.15,
          bm25: { k1: 1.2, b: 0.75 }
        },
        active: false,
        indexedToolCount: 0,
        advertisedToolCount: 0,
        state: catalogState
      }),
      connectedServers: 0,
      toolCount: 0,
      close: async () => undefined
    }
  }
  const pkulawFallbackToken = (
    options.resolvePkulawFallbackToken ?? resolveBundledPkulawToken
  )()

  const outcomeResults = await Promise.allSettled(Object.entries(mcp.servers).map(async ([serverId, server]) => {
    if (!server.enabled) {
      const outcome: McpServerBuildOutcome = {
        diagnostic: serverDiagnostic({ serverId, server }, 'disabled', 0)
      }
      await options.onServerSettled?.({ serverId, diagnostic: outcome.diagnostic })
      return outcome
    }
    try {
      const connectionCandidates = createPkulawConnectionCandidates(server, pkulawFallbackToken)
      const { state, listed } = await connectMcpServer({
        serverId,
        connectionCandidates,
        clientFactory,
        nowIso,
        startupTimeoutMs
      })
      const catalogRecords = listed.map((tool) => createMcpSearchCatalogRecord(state, tool))
      const tools = listed.map((tool) => createMcpLocalTool(state, tool))
      const outcome: McpServerBuildOutcome = {
        state,
        catalogRecords,
        directProvider: {
          id: `mcp:${serverId}`,
          kind: 'mcp',
          enabled: true,
          available: true,
          tools
        },
        diagnostic: serverDiagnostic(state, 'connected', tools.length)
      }
      await options.onServerSettled?.({
        serverId,
        provider: outcome.directProvider,
        diagnostic: outcome.diagnostic
      })
      return outcome
    } catch (error) {
      const outcome: McpServerBuildOutcome = {
        diagnostic: serverDiagnostic(
          { serverId, server },
          'error',
          0,
          redactMcpErrorMessage(error, [server])
        )
      }
      await options.onServerSettled?.({ serverId, diagnostic: outcome.diagnostic })
      return outcome
    }
  }))
  const outcomes = outcomeResults
    .map((result) => (result.status === 'fulfilled' ? result.value : null))
    .filter((outcome): outcome is NonNullable<typeof outcome> => outcome !== null)

  for (const outcome of outcomes) {
    diagnostics.push(outcome.diagnostic)
    if (outcome.state) connected.push(outcome.state)
    if (outcome.catalogRecords) catalogState.records.push(...outcome.catalogRecords)
    if (outcome.directProvider) directProviders.push(outcome.directProvider)
  }

  const connectedServers = diagnostics.filter((diagnostic) => diagnostic.status === 'connected').length
  const toolCount = catalogState.records.length
  catalogState.lastRefreshedAt = nowIso()
  catalogState.catalogFingerprint = catalogFingerprint(catalogState.records.map((record) => record.toolId))
  const searchActive = shouldUseMcpSearch(mcp.search, toolCount) && connectedServers > 0
  if (searchActive) {
    providers.push(createMcpSearchProvider({
      config: mcp.search,
      state: catalogState,
      refreshCatalog: async () => {
        try {
          const records: McpSearchCatalogRecord[] = []
          const previousFingerprint = catalogState.catalogFingerprint
          for (const state of connected) {
            const listed = await refreshMcpConnectionCatalogWithFallback(state)
            records.push(...listed.map((tool) => createMcpSearchCatalogRecord(state, tool)))
          }
          catalogState.records = records
          catalogState.lastError = undefined
          catalogState.lastRefreshedAt = nowIso()
          catalogState.catalogFingerprint = catalogFingerprint(records.map((record) => record.toolId))
          catalogState.catalogDrift = Boolean(previousFingerprint && previousFingerprint !== catalogState.catalogFingerprint)
          return records
        } catch (error) {
          catalogState.lastError = redactSecretText(errorMessage(error))
          throw error
        }
      },
      isServerTrusted: isMcpServerTrusted
    }))
  } else {
    providers.push(...directProviders)
  }
  const advertisedToolCount = providers.reduce((total, provider) => total + provider.tools.length, 0)
  return {
    providers,
    diagnostics,
    search: mcpSearchDiagnostic({
      config: mcp.search,
      active: searchActive,
      indexedToolCount: toolCount,
      advertisedToolCount,
      state: catalogState
    }),
    connectedServers,
    toolCount,
    close: async () => {
      await Promise.all(connected.map((state) => state.client.close().catch(() => undefined)))
    }
  }
}

export function normalizeMcpToolName(serverId: string, toolName: string): string {
  return `mcp_${slug(serverId)}_${slug(toolName)}`
}

export function isMcpServerTrusted(server: McpServerConfig, workspace: string): boolean {
  void server
  void workspace
  return true
}

async function connectMcpServer(input: {
  serverId: string
  connectionCandidates: McpServerConfig[]
  clientFactory: (serverId: string, server: McpServerConfig) => Promise<McpClientLike>
  nowIso: () => string
  startupTimeoutMs: number
}): Promise<{ state: McpConnectionState; listed: McpToolDescriptor[] }> {
  let lastError: Error | undefined
  for (let index = 0; index < input.connectionCandidates.length; index += 1) {
    const server = input.connectionCandidates[index]!
    let client: McpClientLike | undefined
    try {
      client = await input.clientFactory(
        input.serverId,
        serverWithStartupTimeout(server, input.startupTimeoutMs)
      )
      const state: McpConnectionState = {
        serverId: input.serverId,
        server,
        connectionCandidates: input.connectionCandidates,
        activeCandidateIndex: index,
        client,
        clientFactory: input.clientFactory,
        nowIso: input.nowIso,
        lastConnectedAt: input.nowIso()
      }
      const listed = await refreshMcpConnectionCatalog(state)
      return { state, listed }
    } catch (error) {
      await client?.close().catch(() => undefined)
      lastError = redactedMcpError(error, input.connectionCandidates)
    }
  }
  throw lastError ?? new Error(`MCP server ${input.serverId} has no usable connection candidate`)
}

async function createSdkMcpClient(serverId: string, server: McpServerConfig): Promise<McpClientLike> {
  const client = new Client({ name: `legalwork-${serverId}`, version: '0.1.0' })
  const transport = createTransport(server)
  await client.connect(transport, { timeout: server.timeoutMs })
  return {
    listTools: (options) => {
      const params = options?.cursor ? { cursor: options.cursor } : undefined
      return client.listTools(params, {
        signal: options?.signal,
        timeout: options?.timeout
      })
    },
    callTool: (input, options) => client.callTool(input, undefined, options),
    close: () => client.close()
  }
}

function createTransport(server: McpServerConfig): Transport {
  switch (server.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: server.command ?? '',
        args: server.args,
        env: stdioMcpEnv(server.env),
        stderr: 'pipe'
      })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(new URL(server.url ?? ''), {
        requestInit: { headers: server.headers }
      })
    case 'sse':
      return new SSEClientTransport(new URL(server.url ?? ''), {
        requestInit: { headers: server.headers },
        eventSourceInit: { fetch: fetchWithHeaders(server.headers) }
      })
  }
}

function serverWithStartupTimeout(server: McpServerConfig, startupTimeoutMs: number): McpServerConfig {
  if (server.transport === 'stdio') {
    // stdio servers (especially via npx) may need to download/install packages on first run,
    // so guarantee a generous startup window even when the configured runtime timeout is small.
    // A larger user-configured timeout is honored as-is.
    return {
      ...server,
      timeoutMs: Math.max(server.timeoutMs, STDIO_STARTUP_TIMEOUT_MS)
    }
  }
  // Non-stdio servers are capped at the global startup budget so a slow endpoint can't stall boot.
  return {
    ...server,
    timeoutMs: Math.min(server.timeoutMs, startupTimeoutMs)
  }
}

function stdioMcpEnv(env: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') inherited[key] = value
  }
  const merged = { ...inherited, ...env }
  merged.PATH = mergeExecutablePath(env.PATH ?? process.env.PATH)
  return merged
}

function mergeExecutablePath(pathValue: string | undefined): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const part of [...(pathValue ?? '').split(delimiter), ...COMMON_EXEC_PATHS]) {
    const trimmed = part.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    parts.push(trimmed)
  }
  return parts.join(delimiter)
}

function fetchWithHeaders(headers: Record<string, string>): typeof fetch {
  return (input, init) => {
    const mergedHeaders = new Headers(init?.headers)
    for (const [key, value] of Object.entries(headers)) {
      mergedHeaders.set(key, value)
    }
    return fetch(input, { ...init, headers: mergedHeaders })
  }
}

function createMcpLocalTool(
  state: McpConnectionState,
  descriptor: McpToolDescriptor
): LocalTool {
  const officeCliDocuments = isOfficeCliTool(state.serverId, descriptor.name)
    ? new Map<string, string>()
    : undefined
  return LocalToolHost.defineTool({
    name: normalizeMcpToolName(state.serverId, descriptor.name),
    description: isOfficeCliTool(state.serverId, descriptor.name)
      ? officeCliToolDescription(descriptor.description)
      : descriptor.description ?? `MCP tool ${descriptor.name} from ${state.serverId}`,
    inputSchema: normalizeMcpInputSchema(state.serverId, descriptor),
    policy: policyForMcpTool(state.serverId, descriptor),
    shouldAdvertise: (context: ToolHostContext) => isMcpServerTrusted(state.server, context.workspace),
    execute: async (args, context) => {
      if (!isMcpServerTrusted(state.server, context.workspace)) {
        return {
          output: { error: `MCP server ${state.serverId} is not trusted for this workspace` },
          isError: true
        }
      }
      const normalized = officeCliDocuments
        ? normalizeOfficeCliArguments(args, officeCliDocuments.get(context.threadId))
        : { arguments: args }
      if (normalized.error) {
        return {
          output: {
            error: normalized.error,
            hint: 'Pass the complete OfficeCLI command in the command field, including the document file path.'
          },
          isError: true
        }
      }
      const result = await callMcpToolWithReconnect(
        state,
        { name: descriptor.name, arguments: normalized.arguments },
        context.abortSignal
      )
      if (officeCliDocuments && !mcpResultIsError(result)) {
        rememberOfficeCliDocument(
          officeCliDocuments,
          context.threadId,
          normalized.arguments.command
        )
      }
      const hostedResult = await normalizeMcpResultForHost(
        state.serverId,
        descriptor.name,
        result,
        context.workspace
      )
      return {
        output: {
          serverId: state.serverId,
          toolName: descriptor.name,
          result: hostedResult.result,
          ...(hostedResult.artifacts.length > 0
            ? {
                file_path: hostedResult.artifacts[0],
                artifacts: hostedResult.artifacts
              }
            : {})
        },
        isError: typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true
      }
    }
  })
}

type OfficeCliNormalization = {
  arguments: Record<string, unknown>
  error?: string
}

function isOfficeCliTool(serverId: string, toolName: string): boolean {
  return serverId.toLowerCase() === 'officecli' && toolName.toLowerCase() === 'officecli'
}

function normalizeMcpInputSchema(
  serverId: string,
  descriptor: McpToolDescriptor
): Record<string, unknown> {
  const schema = descriptor.inputSchema ?? { type: 'object' }
  if (!isOfficeCliTool(serverId, descriptor.name)) return schema
  const properties = typeof schema.properties === 'object' && schema.properties !== null
    ? schema.properties as Record<string, unknown>
    : {}
  return {
    ...schema,
    properties: {
      ...properties,
      file: {
        type: 'string',
        description: 'Document path. May be omitted after a successful create/open in this task.'
      },
      parent: {
        type: 'string',
        description: 'Parent document element path for a bare add command, such as /body.'
      },
      path: {
        type: 'string',
        description: 'Document element path for a bare get/set/remove command.'
      },
      type: {
        type: 'string',
        description: 'Element type for a bare add command.'
      },
      props: {
        type: 'object',
        additionalProperties: true,
        description: 'Element properties for a bare add/set command.'
      },
      commands: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description:
          'Structured batch operations. Use with command="batch"; each item uses a bare command plus sibling fields such as parent/path/type/props.'
      },
      stop_on_error: {
        type: 'boolean',
        description: 'For batch only. Stop at the first failed operation instead of reporting per-item errors.'
      }
    },
    additionalProperties: false
  }
}

function officeCliToolDescription(baseDescription?: string): string {
  return [
    baseDescription ?? 'Read and write Office documents through OfficeCLI.',
    '',
    'Efficiency and quality contract:',
    '- Keep requested content, citations, structure, and visible formatting complete; batching is only an execution optimization.',
    '- For three or more related add/set operations, prefer one batch call instead of many single calls.',
    '- Structured form: command="batch", file="/path/report.docx", commands=[{"command":"add","parent":"/body","type":"paragraph","props":{"text":"..."}}].',
    '- Equivalent argv form: ["batch","/path/report.docx","--commands","<JSON array>","--json"].',
    '- Batch items use a bare verb with sibling fields (parent/path/type/props); do not put a full CLI string inside an item command.',
    '- If a batch partially fails, retry only failed items. Never repeat identical failed arguments.',
    '- Save and validate after substantive writing. Once validation passes, only repair remaining issues that materially affect requested content, structure, or visible formatting.'
  ].join('\n')
}

/**
 * OfficeCLI exposes one `command` argument, but some OpenAI-compatible models
 * occasionally split CLI flags into tool-call fields. Recover the safe subset
 * here so a resident document can still be edited instead of executing a bare
 * `add`/`set` command and dumping CLI help into the conversation.
 */
export function normalizeOfficeCliArguments(
  input: Record<string, unknown>,
  activeDocument?: string
): OfficeCliNormalization {
  const rawCommand = input.command
  const parsedArray = parseJsonStringArray(rawCommand)
  if (parsedArray) return { arguments: { command: parsedArray } }
  if (Array.isArray(rawCommand)) {
    if (!rawCommand.every((part) => typeof part === 'string')) {
      return { arguments: {}, error: 'OfficeCLI command arrays may only contain strings.' }
    }
    return { arguments: { command: rawCommand } }
  }
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) {
    return { arguments: {}, error: 'OfficeCLI command is required.' }
  }

  const words = officeCliCommandWords(rawCommand)
  if (words.length !== 1) return { arguments: { command: rawCommand } }
  const verb = words[0]?.toLowerCase()
  if (!verb || !OFFICECLI_FILE_COMMANDS.has(verb)) {
    return { arguments: { command: rawCommand } }
  }

  const file = scalarToolArgument(input.file)
    ?? scalarToolArgument(input.document)
    ?? (!OFFICECLI_PARENT_COMMANDS.has(verb) ? scalarToolArgument(input.path) : undefined)
    ?? activeDocument
  if (!file) {
    return {
      arguments: {},
      error: `OfficeCLI ${verb} requires a document file path; no active document is recorded for this task.`
    }
  }

  const command = [verb, file]
  if (OFFICECLI_PARENT_COMMANDS.has(verb)) {
    const parent = scalarToolArgument(input.parent)
      ?? scalarToolArgument(input.target)
      ?? scalarToolArgument(input.element)
      ?? scalarToolArgument(input.path)
    if (!parent) {
      return {
        arguments: {},
        error: `OfficeCLI ${verb} requires a document element path such as /body.`
      }
    }
    command.push(parent)
  }
  appendOfficeCliOptions(command, input)
  return { arguments: { command } }
}

const OFFICECLI_FILE_COMMANDS = new Set([
  'create', 'open', 'close', 'save', 'view', 'validate', 'get', 'query', 'set', 'add', 'remove', 'move', 'swap', 'batch', 'raw'
])
const OFFICECLI_PARENT_COMMANDS = new Set(['get', 'set', 'add', 'remove', 'move', 'swap'])

function appendOfficeCliOptions(command: string[], input: Record<string, unknown>): void {
  const type = scalarToolArgument(input.type)
  if (type) command.push('--type', type)
  for (const [name, value] of Object.entries(objectToolArgument(input.props) ?? objectToolArgument(input.properties) ?? {})) {
    const normalized = scalarToolArgument(value)
    if (normalized !== undefined) command.push('--prop', `${name}=${normalized}`)
  }
  for (const option of ['from', 'index', 'after', 'before', 'input'] as const) {
    const value = scalarToolArgument(input[option])
    if (value !== undefined) command.push(`--${option}`, value)
  }
  const commands = input.commands
  if (Array.isArray(commands)) {
    command.push('--commands', JSON.stringify(commands))
  } else if (typeof commands === 'string' && commands.trim()) {
    command.push('--commands', commands.trim())
  }
  if (input.stop_on_error === true || input.stopOnError === true) {
    command.push('--stop-on-error')
  }
  if (input.force === true) command.push('--force')
  if (input.json === true || (command[0]?.toLowerCase() === 'batch' && input.json !== false)) {
    command.push('--json')
  }
  const additional = input.additionalArguments ?? input.additional_arguments
  if (Array.isArray(additional)) {
    for (const value of additional) {
      const normalized = scalarToolArgument(value)
      if (normalized !== undefined) command.push(normalized)
    }
  }
}

function scalarToolArgument(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function objectToolArgument(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseJsonStringArray(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || !value.trim().startsWith('[')) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((part) => typeof part === 'string')
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

function officeCliCommandWords(command: unknown): string[] {
  if (Array.isArray(command)) {
    return command.filter((part): part is string => typeof part === 'string')
  }
  if (typeof command !== 'string') return []
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const char of command.trim()) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (escaped) current += '\\'
  if (current) words.push(current)
  if (words[0]?.toLowerCase() === 'officecli') words.shift()
  return words
}

function rememberOfficeCliDocument(
  documents: Map<string, string>,
  threadId: string,
  command: unknown
): void {
  const words = officeCliCommandWords(command)
  const verb = words[0]?.toLowerCase()
  const file = words[1]
  if (!verb || !file) return
  if (verb === 'create' || verb === 'open') {
    documents.set(threadId, file)
  } else if (verb === 'close' && documents.get(threadId) === file) {
    documents.delete(threadId)
  }
}

function mcpResultIsError(result: unknown): boolean {
  return typeof result === 'object'
    && result !== null
    && (result as { isError?: boolean }).isError === true
}

async function listAllMcpTools(client: McpClientLike, timeout: number): Promise<McpToolDescriptor[]> {
  const tools: McpToolDescriptor[] = []
  let cursor: string | undefined
  do {
    const listed = await client.listTools({ cursor, timeout })
    tools.push(...listed.tools)
    cursor = listed.nextCursor
  } while (cursor)
  return tools
}

function createMcpSearchCatalogRecord(
  state: McpConnectionState,
  descriptor: McpToolDescriptor
): McpSearchCatalogRecord {
  return {
    toolId: `${state.serverId}/${descriptor.name}`,
    serverId: state.serverId,
    server: state.server,
    client: {
      callTool: (input, options) =>
        callMcpToolWithReconnect(state, input, options?.signal, options?.timeout)
    },
    descriptor,
    normalizedName: normalizeMcpToolName(state.serverId, descriptor.name),
    policy: policyForMcpTool(state.serverId, descriptor)
  }
}

async function refreshMcpConnectionCatalog(state: McpConnectionState): Promise<McpToolDescriptor[]> {
  const listed = (await listAllMcpTools(state.client, state.server.timeoutMs))
    .filter((tool) => !isUnsupportedFlintMcpAppTool(state.serverId, tool))
  const nextFingerprint = catalogFingerprint(listed.map((tool) => tool.name))
  state.catalogDrift = Boolean(state.catalogFingerprint && state.catalogFingerprint !== nextFingerprint)
  state.catalogFingerprint = nextFingerprint
  state.lastError = undefined
  return listed
}

async function refreshMcpConnectionCatalogWithFallback(
  state: McpConnectionState
): Promise<McpToolDescriptor[]> {
  try {
    return await refreshMcpConnectionCatalog(state)
  } catch (error) {
    state.lastError = redactMcpErrorMessage(error, state.connectionCandidates)
    const client = await reconnectMcpConnection(state)
    void client
    try {
      return await refreshMcpConnectionCatalog(state)
    } catch (retryError) {
      throw redactedMcpError(retryError, state.connectionCandidates)
    }
  }
}

async function callMcpToolWithReconnect(
  state: McpConnectionState,
  input: { name: string; arguments: Record<string, unknown> },
  signal: AbortSignal | undefined,
  timeout = state.server.timeoutMs
): Promise<unknown> {
  try {
    const result = await state.client.callTool(input, { signal, timeout })
    if (mcpResultRequiresCredentialFallback(result) && hasNextConnectionCandidate(state)) {
      const client = await reconnectMcpConnection(state)
      const retried = await client.callTool(input, { signal, timeout })
      return redactMcpPayload(retried, state.connectionCandidates)
    }
    return redactMcpPayload(result, state.connectionCandidates)
  } catch (error) {
    state.lastError = redactMcpErrorMessage(error, state.connectionCandidates)
    if (signal?.aborted) throw error
    try {
      const client = await reconnectMcpConnection(state)
      const result = await client.callTool(input, { signal, timeout })
      return redactMcpPayload(result, state.connectionCandidates)
    } catch (retryError) {
      throw redactedMcpError(retryError, state.connectionCandidates)
    }
  }
}

// 重连超时：stdio 冷启动（spawn 子进程 + 可能首次启动）需要更宽预算，
// 网络型（sse/http）则更快超时避免拖死调用。
const MCP_RECONNECT_TIMEOUT_MS = 15_000
const MCP_RECONNECT_STDIO_TIMEOUT_MS = 45_000

async function reconnectMcpConnection(state: McpConnectionState): Promise<McpClientLike> {
  const isStdio = state.server.transport === 'stdio'
  const reconnectTimeoutMs = isStdio ? MCP_RECONNECT_STDIO_TIMEOUT_MS : MCP_RECONNECT_TIMEOUT_MS
  // 给 close 加超时，避免客户端卡在关闭流程导致调用挂死；同时清理 timer。
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    state.client.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      closeTimer = setTimeout(resolve, reconnectTimeoutMs)
    })
  ])
  if (closeTimer) clearTimeout(closeTimer)
  const nextIndex = hasNextConnectionCandidate(state)
    ? state.activeCandidateIndex + 1
    : state.activeCandidateIndex
  const indexes = [
    ...Array.from(
      { length: state.connectionCandidates.length - nextIndex },
      (_, offset) => nextIndex + offset
    ),
    ...(nextIndex === state.activeCandidateIndex ? [] : [state.activeCandidateIndex])
  ]
  let lastError: unknown
  for (const index of indexes) {
    const server = state.connectionCandidates[index]!
    let connecting: Promise<McpClientLike> | undefined
    try {
      connecting = state.clientFactory(state.serverId, server)
      const client = await Promise.race([
        connecting,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`MCP reconnect to ${server.command ?? server.url ?? index} timed out after ${reconnectTimeoutMs}ms`)),
            reconnectTimeoutMs
          )
        )
      ])
      state.server = server
      state.activeCandidateIndex = index
      state.client = client
      state.lastConnectedAt = state.nowIso()
      state.lastError = undefined
      return client
    } catch (error) {
      // 超时/失败时，若 clientFactory 仍在后台建立连接，把随后连上的 client
      // 关闭掉，避免孤儿连接/子进程泄漏（stdio transport 会 spawn 进程）。
      if (connecting) {
        void connecting
          .then((leaked) => leaked.close().catch(() => undefined))
          .catch(() => undefined)
      }
      lastError = error
    }
  }
  // 所有候选都失败：旧的 state.client 可能已处于半关闭状态，不能再复用。
  // 清理掉，避免后续调用复用一个损坏的连接。
  const staleClient = state.client
  if (staleClient) {
    state.client = undefined as unknown as McpClientLike
    void staleClient.close().catch(() => undefined)
  }
  // No viable candidate found; throw the last error or a clear fallback
  if (lastError) throw redactedMcpError(lastError, state.connectionCandidates)
  throw new Error(`MCP server ${state.serverId}: all connection candidates failed (${state.connectionCandidates.length} tried)`)
}

function hasNextConnectionCandidate(state: McpConnectionState): boolean {
  return state.activeCandidateIndex + 1 < state.connectionCandidates.length
}

function mcpResultRequiresCredentialFallback(result: unknown): boolean {
  if (!mcpResultIsError(result)) return false
  return /\b(401|403|429)\b|unauthori[sz]ed|forbidden|invalid[^.\n]*(token|credential)|quota|鉴权|认证|令牌|权限|额度/i
    .test(stringifyForSecretScan(result))
}

function isFlintChartServer(serverId: string): boolean {
  return FLINT_CHART_SERVER_IDS.has(serverId.toLowerCase())
}

function isUnsupportedFlintMcpAppTool(
  serverId: string,
  descriptor: McpToolDescriptor
): boolean {
  return isFlintChartServer(serverId) && descriptor.name === 'create_chart_view'
}

function policyForMcpTool(
  serverId: string,
  descriptor: McpToolDescriptor
): LocalTool['policy'] {
  if (
    isFlintChartServer(serverId) &&
    descriptor.annotations?.destructiveHint !== true &&
    descriptor.annotations?.openWorldHint !== true
  ) {
    return 'auto'
  }
  return policyFromAnnotations(descriptor.annotations)
}

type HostedMcpResult = {
  result: unknown
  artifacts: string[]
}

async function normalizeMcpResultForHost(
  serverId: string,
  toolName: string,
  result: unknown,
  workspace: string
): Promise<HostedMcpResult> {
  if (!isFlintChartServer(serverId) || toolName !== 'render_chart') {
    return { result, artifacts: [] }
  }
  if (
    !result ||
    typeof result !== 'object' ||
    !Array.isArray((result as { content?: unknown }).content)
  ) {
    return { result, artifacts: [] }
  }

  const outputDir = workspace.trim()
    ? join(workspace, '.legalwork', 'flint-charts')
    : ''
  const content = (result as { content: unknown[] }).content
  const artifacts: string[] = []
  const normalizedContent: unknown[] = []

  for (const item of content) {
    const record = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null
    const imageData = record?.type === 'image' && typeof record.data === 'string'
      ? record.data
      : null
    const mimeType = typeof record?.mimeType === 'string' ? record.mimeType : 'image/png'
    const svgText = record?.type === 'text' &&
      typeof record.text === 'string' &&
      record.text.trimStart().startsWith('<svg')
      ? record.text
      : null

    if (!imageData && !svgText) {
      normalizedContent.push(item)
      continue
    }
    if (!outputDir) {
      normalizedContent.push({
        type: 'text',
        text: 'Chart rendered, but no workspace was available to save the artifact.'
      })
      continue
    }

    try {
      await mkdir(outputDir, { recursive: true })
      const extension = svgText
        ? 'svg'
        : mimeType === 'image/jpeg'
          ? 'jpg'
          : mimeType === 'image/webp'
            ? 'webp'
            : 'png'
      const artifactPath = join(outputDir, `flint-chart-${randomUUID()}.${extension}`)
      if (svgText) {
        await writeFile(artifactPath, svgText, 'utf8')
      } else {
        await writeFile(artifactPath, Buffer.from(imageData ?? '', 'base64'))
      }
      artifacts.push(artifactPath)
      normalizedContent.push({
        type: 'text',
        text: `Chart artifact saved to ${artifactPath}`
      })
    } catch (error) {
      normalizedContent.push({
        type: 'text',
        text: `Chart rendered, but the artifact could not be saved: ${errorMessage(error)}`
      })
    }
  }

  return {
    result: {
      ...(result as Record<string, unknown>),
      content: normalizedContent
    },
    artifacts
  }
}

function shouldUseMcpSearch(config: NonNullable<McpCapabilityConfig['search']>, toolCount: number): boolean {
  if (!config.enabled) return false
  if (config.mode === 'direct') return false
  if (config.mode === 'search') return true
  return toolCount >= config.autoThresholdToolCount
}

function policyFromAnnotations(annotation: McpToolDescriptor['annotations']): LocalTool['policy'] {
  if (annotation?.readOnlyHint && !annotation.openWorldHint && !annotation.destructiveHint) return 'auto'
  if (annotation?.destructiveHint) return 'on-request'
  if (annotation?.openWorldHint) return 'untrusted'
  return 'on-request'
}

function serverDiagnostic(
  state: { serverId: string; server: McpServerConfig; catalogFingerprint?: string; catalogDrift?: boolean; lastConnectedAt?: string },
  status: McpServerDiagnostic['status'],
  toolCount: number,
  lastError?: string
): McpServerDiagnostic {
  return {
    id: state.serverId,
    enabled: state.server.enabled,
    transport: state.server.transport,
    trustScope: state.server.trustScope,
    available: status === 'connected',
    status,
    toolCount,
    ...(state.catalogFingerprint ? { catalogFingerprint: state.catalogFingerprint } : {}),
    ...(state.catalogDrift !== undefined ? { catalogDrift: state.catalogDrift } : {}),
    ...(state.lastConnectedAt ? { lastConnectedAt: state.lastConnectedAt } : {}),
    ...(lastError ? { lastError: redactSecretText(lastError) } : {})
  }
}

function catalogFingerprint(values: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...values].sort()))
    .digest('hex')
    .slice(0, 16)
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
}

function normalizePathForTrust(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '')
}

function redactMcpPayload<T>(value: T, servers: McpServerConfig[]): T {
  const secrets = mcpServerSecretValues(servers)
  const visit = (input: unknown): unknown => {
    if (typeof input === 'string') return redactKnownSecretText(input, secrets)
    if (Array.isArray(input)) return input.map(visit)
    if (!input || typeof input !== 'object') return input
    return Object.fromEntries(
      Object.entries(input).map(([key, child]) => [
        key,
        /authorization|token|secret|password|api[-_]?key/i.test(key)
          ? REDACTED_SECRET
          : visit(child)
      ])
    )
  }
  return visit(value) as T
}

function redactMcpErrorMessage(error: unknown, servers: McpServerConfig[]): string {
  return redactKnownSecretText(errorMessage(error), mcpServerSecretValues(servers))
}

function redactedMcpError(error: unknown, servers: McpServerConfig[]): Error {
  const safe = new Error(redactMcpErrorMessage(error, servers))
  safe.name = error instanceof Error ? error.name : 'Error'
  return safe
}

function redactKnownSecretText(value: string, secrets: string[]): string {
  let redacted = value
  for (const secret of secrets) {
    if (secret.length >= 8) redacted = redacted.split(secret).join(REDACTED_SECRET)
  }
  return redactSecretText(redacted)
}

function mcpServerSecretValues(servers: McpServerConfig[]): string[] {
  const values = new Set<string>()
  for (const server of servers) {
    // Extract from Authorization and other secret headers
    for (const [key, value] of Object.entries(server.headers)) {
      if (!/authorization|token|secret|password|api[-_]?key/i.test(key)) continue
      const trimmed = value.trim()
      if (!trimmed) continue
      values.add(trimmed)
      const bearer = trimmed.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
      if (bearer) values.add(bearer)
    }
    // Extract embedded credentials from URL (user:password@host)
    if (server.url) {
      try {
        const parsed = new URL(server.url)
        if (parsed.password) values.add(parsed.password)
        if (parsed.username) values.add(parsed.username)
      } catch { /* ignore invalid URLs */ }
    }
    // Extract token-like values from env (secret-looking env values)
    for (const [, value] of Object.entries(server.env)) {
      const trimmed = value.trim()
      if (!trimmed || trimmed.length < 16) continue
      if (/^(?:sk-|pk-|Bearer\s+|eyJ)/i.test(trimmed)) values.add(trimmed)
    }
    // Extract token-like values from command args
    for (const arg of server.args) {
      const trimmed = arg.trim()
      if (!trimmed || trimmed.length < 16) continue
      if (/^(?:sk-|pk-|eyJ|[A-Za-z0-9_-]{20,})/.test(trimmed)) values.add(trimmed)
    }
  }
  return [...values].sort((left, right) => right.length - left.length)
}

function stringifyForSecretScan(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
