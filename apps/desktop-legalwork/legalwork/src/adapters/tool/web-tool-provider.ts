import type { LegalworkCapabilitiesConfig, WebCapabilityConfig } from '../../contracts/capabilities.js'
import type { WebFetchResult, WebProvider, WebSearchRequest, WebSearchResult } from '../../ports/web-provider.js'
import { sourceIdFor, UnavailableWebProvider } from '../../ports/web-provider.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import { AnysearchWebProvider } from './anysearch-web-provider.js'
import { DeepseekServerSearchProvider } from './deepseek-server-search-provider.js'

const DEFAULT_WEB_TIMEOUT_MS = 15_000
// 服务端搜索(deepseek-server-search)单次请求需完成 LLM 推理+多次 web search+生成，
// 15s 频繁误杀真实搜索（search_failed/aborted），单独放宽到 60s
const DEFAULT_SEARCH_TIMEOUT_MS = 60_000
const DEEPSEEK_PRIMARY_SEARCH_TIMEOUT_MS = 35_000
// Cap web_fetch at ~96KB (~24K tokens) instead of 1MB: a full page can
// otherwise inject up to ~250K tokens into the context as a single tool
// result and dominate turn cost, especially during research tool loops.
const DEFAULT_WEB_MAX_BYTES = 96 * 1024
const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 10

export type WebProviderDiagnostic = {
  id: string
  enabled: boolean
  available: boolean
  fetchAvailable: boolean
  searchAvailable: boolean
  provider?: string
  reason?: string
}

export type WebToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  diagnostics: WebProviderDiagnostic[]
  fetchAvailable: boolean
  searchAvailable: boolean
  provider?: string
}

export type WebToolProviderOptions = {
  provider?: WebProvider
  nowIso?: () => string
  /** AnySearch API key for web search. When set, search is enabled automatically. */
  anysearchApiKey?: string
  /** DeepSeek API key + endpoint for the server-side web_search tool. When set, search uses the DeepSeek server tool (cheap, no local round-trip). */
  deepseekApiKey?: string
  deepseekBaseUrl?: string
  deepseekModel?: string
}

/**
 * Prefer the cheap DeepSeek server-side search, but do not let a 404, timeout,
 * empty response, or route mismatch fail the whole turn. The fallback shares
 * one total deadline with the primary so two providers cannot multiply latency.
 */
export class FallbackSearchWebProvider implements WebProvider {
  readonly id: string

  constructor(
    private readonly primary: WebProvider,
    private readonly fallback: WebProvider,
    private readonly primaryTimeoutMs = DEEPSEEK_PRIMARY_SEARCH_TIMEOUT_MS
  ) {
    this.id = `${primary.id}+${fallback.id}`
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    if (!this.primary.search || !this.fallback.search) {
      throw new Error('web search fallback provider is unavailable')
    }
    const totalTimeoutMs = Math.max(1, request.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS)
    const startedAt = Date.now()
    const primaryBudget = Math.min(
      totalTimeoutMs,
      Math.max(1, Math.min(this.primaryTimeoutMs, Math.floor(totalTimeoutMs * 0.7)))
    )
    let primaryError = 'primary provider returned no results'
    try {
      const results = await searchWithDeadline(this.primary, request, primaryBudget)
      if (results.length > 0) return results
    } catch (error) {
      primaryError = errorMessage(error)
    }

    const remainingMs = totalTimeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      throw new Error(`primary web search failed and exhausted the deadline: ${primaryError}`)
    }
    try {
      const results = await searchWithDeadline(this.fallback, request, remainingMs)
      if (results.length > 0) return results
      throw new Error('fallback provider returned no results')
    } catch (error) {
      throw new Error(`web search providers failed; primary: ${primaryError}; fallback: ${errorMessage(error)}`)
    }
  }
}

export function buildWebToolProviders(
  config: LegalworkCapabilitiesConfig['web'] | undefined,
  options: WebToolProviderOptions = {}
): WebToolProviderBuildResult {
  const web = config
  if (!web?.enabled) {
    return {
      providers: [],
      diagnostics: [],
      fetchAvailable: false,
      searchAvailable: false
    }
  }

  // Search provider: an explicitly injected provider wins (tests, private
  // deployments and future adapters). Otherwise the DeepSeek server-side
  // web_search tool is preferred when a DeepSeek API key is available (cheap,
  // executes in the API, no local round-trip). AnySearch is the fallback when
  // no DeepSeek key is configured, or when the configured provider is "anysearch".
  const anysearchKey = options.anysearchApiKey?.trim()
  const anysearchProvider = new AnysearchWebProvider({ apiKey: anysearchKey || undefined, nowIso: options.nowIso })
  // 服务端 web_search 复用 DeepSeek 主 API key，无额外成本：只要配置了 DeepSeek
  // key 就自动启用搜索（不受旧 AnySearch 时代 searchEnabled=false 的限制），
  // 保证元典/北大法宝都不可用时模型有 web_search 兜底可用。
  // 尊重显式 searchEnabled=false（保密性/合规场景可关）；
  // 未显式配置(undefined)时，有 DeepSeek key 才自动启用服务端搜索（默认开）。
  const searchEnabled = web.searchEnabled ?? Boolean(options.deepseekApiKey?.trim())
  const fetchProvider: WebProvider = options.provider ?? (web.fetchEnabled
    ? new FetchWebProvider(options.nowIso)
    : new UnavailableWebProvider(web.provider))
  const deepseekSearchProvider = options.deepseekApiKey?.trim()
    ? new DeepseekServerSearchProvider({
          apiKey: options.deepseekApiKey,
          baseUrl: options.deepseekBaseUrl,
          model: options.deepseekModel,
          nowIso: options.nowIso
        })
    : undefined
  const searchProvider: WebProvider = options.provider ?? (
    deepseekSearchProvider
      ? new FallbackSearchWebProvider(deepseekSearchProvider, anysearchProvider)
      : (!web.provider || web.provider === 'anysearch'
          ? anysearchProvider
          : new UnavailableWebProvider(web.provider))
  )

  const tools = []
  if (web.fetchEnabled) {
    tools.push(createFetchTool(web, fetchProvider))
  }
  if (searchEnabled) {
    tools.push(createSearchTool(web, searchProvider))
  }
  const fetchAvailable = Boolean(web.fetchEnabled && fetchProvider.fetch)
  const searchAvailable = Boolean(searchEnabled && searchProvider.search)
  const reason = !tools.length
    ? 'web tools are disabled by config'
    : !fetchAvailable && !searchAvailable
      ? 'web provider is unavailable'
      : undefined

  return {
    providers: tools.length
      ? [{
          id: 'web',
          kind: 'web',
          enabled: true,
          available: true,
          ...(reason ? { reason } : {}),
          tools
        }]
      : [],
    diagnostics: [{
      id: 'web',
      enabled: true,
      available: fetchAvailable || searchAvailable,
      fetchAvailable,
      searchAvailable,
      provider: searchEnabled ? searchProvider.id : fetchProvider.id,
      ...(reason ? { reason } : {})
    }],
    fetchAvailable,
    searchAvailable,
    provider: searchEnabled ? searchProvider.id : fetchProvider.id
  }
}

function createFetchTool(config: WebCapabilityConfig, provider: WebProvider) {
  return LocalToolHost.defineTool({
    name: 'web_fetch',
    description: 'Fetch an HTTP(S) URL and return its extracted text. Use it to read pages when you need the full body text — e.g. a specific article, report, official document, or legal text — including following up on web_search results when the snippet is only a title and you need the actual content (court judgment details, regulation text, news article body). Do NOT fetch every search result indiscriminately; fetch only the specific page(s) that matter. Do NOT use it on local files (use read instead).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_bytes: { type: 'number' },
        timeout_ms: { type: 'number' }
      },
      required: ['url'],
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context) => {
      const startedAt = Date.now()
      const rawUrl = pickString(args.url)
      if (!rawUrl) return toolError('invalid_url', 'url is required')
      const policy = validateUrlPolicy(rawUrl, config)
      if (!policy.ok) return toolError('policy_blocked', policy.reason, telemetry({ startedAt, policy: 'blocked', url: rawUrl }))
      if (!provider.fetch) return toolError('provider_unavailable', 'web fetch provider is unavailable')
      const maxBytes = boundedInt(args.max_bytes, DEFAULT_WEB_MAX_BYTES, 1, DEFAULT_WEB_MAX_BYTES)
      const timeoutMs = boundedInt(args.timeout_ms, DEFAULT_WEB_TIMEOUT_MS, 1, DEFAULT_WEB_TIMEOUT_MS)
      try {
        const result = await provider.fetch({
          url: policy.url.href,
          maxBytes,
          timeoutMs,
          signal: context.abortSignal
        })
        return {
          output: fetchOutput(result, telemetry({
            startedAt,
            policy: 'allowed',
            url: policy.url.href,
            provider: provider.id,
            byteCount: result.byteCount
          }))
        }
      } catch (error) {
        return toolError('fetch_failed', errorMessage(error), telemetry({
          startedAt,
          policy: 'allowed',
          url: policy.url.href,
          provider: provider.id
        }))
      }
    }
  })
}

function createSearchTool(config: WebCapabilityConfig, provider: WebProvider) {
  return LocalToolHost.defineTool({
    name: 'web_search',
    description: 'Search the web through the configured provider and return ranked results with source metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        timeout_ms: { type: 'number' }
      },
      required: ['query'],
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context) => {
      const startedAt = Date.now()
      const query = pickString(args.query)
      if (!query) return toolError('invalid_query', 'query is required')
      if (!provider.search) return toolError('provider_unavailable', 'web search provider is unavailable')
      const limit = boundedInt(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
      // 搜索超时用独立上限（服务端搜索一次请求耗时较长），与 web_fetch 的 15s 分开
      const timeoutMs = boundedInt(args.timeout_ms, DEFAULT_SEARCH_TIMEOUT_MS, 1, DEFAULT_SEARCH_TIMEOUT_MS)
      try {
        const results = await searchWithDeadline(provider, {
          query,
          limit,
          timeoutMs,
          signal: context.abortSignal
        }, timeoutMs)
        return {
          output: searchOutput(query, provider.id, results, telemetry({
            startedAt,
            policy: 'allowed',
            provider: provider.id,
            query,
            resultCount: results.length
          }))
        }
      } catch (error) {
        return toolError('search_failed', errorMessage(error), telemetry({
          startedAt,
          policy: 'allowed',
          provider: provider.id,
          query
        }))
      }
    }
  })
}

async function searchWithDeadline(
  provider: WebProvider,
  request: WebSearchRequest,
  timeoutMs: number
): Promise<WebSearchResult[]> {
  if (!provider.search) throw new Error('web search provider is unavailable')
  if (request.signal.aborted) throw new Error('web search was aborted')
  const controller = new AbortController()
  let rejectDeadline: ((error: Error) => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const onAbort = (): void => {
    controller.abort()
    rejectDeadline?.(new Error('web search was aborted'))
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort()
    rejectDeadline?.(new Error(`web search timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  try {
    return await Promise.race([
      provider.search({ ...request, timeoutMs, signal: controller.signal }),
      deadline
    ])
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', onAbort)
  }
}

class FetchWebProvider implements WebProvider {
  readonly id = 'fetch'
  private readonly nowIso: () => string

  constructor(nowIso: (() => string) | undefined) {
    this.nowIso = nowIso ?? (() => new Date().toISOString())
  }

  async fetch(request: {
    url: string
    maxBytes: number
    timeoutMs: number
    signal: AbortSignal
  }): Promise<WebFetchResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
    const onAbort = () => controller.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(request.url, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      // Oversized pages truncate at maxBytes via the streaming read below.
      // Hard-failing on the declared content-length made most real pages
      // unfetchable whenever the model passed a small byte budget.

      // Stream response body with size limit
      const reader = response.body?.getReader()
      if (!reader) throw new Error('response body is not readable')

      const chunks: Uint8Array[] = []
      let totalBytes = 0
      let truncated = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const remaining = request.maxBytes - totalBytes
        if (remaining <= 0) {
          truncated = true
          reader.cancel()
          break
        }

        if (value.length > remaining) {
          chunks.push(value.subarray(0, remaining))
          totalBytes += remaining
          truncated = true
          reader.cancel()
          break
        }

        chunks.push(value)
        totalBytes += value.length
      }

      const buffer = Buffer.concat(chunks)

      const contentType = response.headers.get('content-type') ?? undefined
      const raw = buffer.toString('utf8')
      const extracted = extractReadableText(raw, contentType)
      const finalUrl = response.url || request.url
      return {
        sourceId: sourceIdFor('fetch', finalUrl),
        url: request.url,
        finalUrl,
        title: extracted.title,
        contentType,
        text: extracted.text,
        retrievedAt: this.nowIso(),
        byteCount: totalBytes,
        truncated
      }
    } finally {
      clearTimeout(timeout)
      request.signal.removeEventListener('abort', onAbort)
    }
  }
}

function fetchOutput(result: WebFetchResult, toolTelemetry: Record<string, unknown>) {
  const source = {
    sourceId: result.sourceId,
    url: result.finalUrl,
    title: result.title,
    retrievedAt: result.retrievedAt
  }
  return {
    sourceId: result.sourceId,
    url: result.url,
    finalUrl: result.finalUrl,
    title: result.title,
    retrievedAt: result.retrievedAt,
    contentType: result.contentType,
    text: result.text,
    byteCount: result.byteCount,
    truncated: result.truncated,
    sources: [source],
    citations: [source],
    telemetry: toolTelemetry
  }
}

function searchOutput(
  query: string,
  provider: string,
  results: WebSearchResult[],
  toolTelemetry: Record<string, unknown>
) {
  const sources = results.map((result) => ({
    sourceId: result.sourceId,
    url: result.url,
    title: result.title,
    retrievedAt: result.retrievedAt
  }))
  return {
    query,
    provider,
    results,
    sources,
    citations: sources,
    telemetry: toolTelemetry
  }
}

function validateUrlPolicy(rawUrl: string, config: WebCapabilityConfig): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'URL must be absolute' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'only http and https URLs are allowed' }
  }
  const hostname = url.hostname.toLowerCase()
  if (config.denyDomains.some((domain) => domainMatches(hostname, domain))) {
    return { ok: false, reason: `domain is denied: ${hostname}` }
  }
  if (config.allowDomains.length > 0 && !config.allowDomains.some((domain) => domainMatches(hostname, domain))) {
    return { ok: false, reason: `domain is not allowed: ${hostname}` }
  }
  return { ok: true, url }
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, '')
  return hostname === normalized || hostname.endsWith(`.${normalized}`)
}

function extractReadableText(raw: string, contentType: string | undefined): { title?: string; text: string } {
  if (!contentType?.toLowerCase().includes('html')) {
    return { text: normalizeWhitespace(raw) }
  }
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const withoutScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  const text = withoutScripts
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return {
    ...(title ? { title: normalizeWhitespace(decodeHtmlEntities(title)) } : {}),
    text: normalizeWhitespace(decodeHtmlEntities(text))
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function telemetry(input: {
  startedAt: number
  policy: 'allowed' | 'blocked'
  provider?: string
  url?: string
  query?: string
  byteCount?: number
  resultCount?: number
}): Record<string, unknown> {
  return {
    provider: input.provider,
    url: input.url,
    query: input.query,
    byteCount: input.byteCount,
    resultCount: input.resultCount,
    durationMs: Date.now() - input.startedAt,
    cacheStatus: 'miss',
    policy: input.policy
  }
}

function toolError(code: string, message: string, toolTelemetry?: Record<string, unknown>) {
  return {
    output: {
      error: {
        code,
        message
      },
      ...(toolTelemetry ? { telemetry: toolTelemetry } : {})
    },
    isError: true
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
