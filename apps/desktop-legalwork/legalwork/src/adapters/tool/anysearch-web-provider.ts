import type { WebFetchResult, WebProvider, WebSearchRequest, WebSearchResult } from '../../ports/web-provider.js'
import { sourceIdFor } from '../../ports/web-provider.js'

const ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/mcp'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_LIMIT = 8
const ANYSEARCH_MAX_FETCH_BYTES = 256 * 1024

/**
 * AnySearch-powered web provider for Legalwork.
 *
 * Uses JSON-RPC 2.0 to communicate with the AnySearch MCP API.
 * Supports both anonymous access (lower rate limits) and API key mode.
 */
export class AnysearchWebProvider implements WebProvider {
  readonly id = 'anysearch'

  private readonly apiKey: string | undefined
  private readonly nowIso: () => string

  constructor(options?: { apiKey?: string; nowIso?: () => string }) {
    this.apiKey = options?.apiKey?.trim() || undefined
    this.nowIso = options?.nowIso ?? (() => new Date().toISOString())
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    const resultText = await this.callTool('search', {
      query: request.query,
      limit: Math.min(request.limit || DEFAULT_LIMIT, 20)
    }, request.signal, request.timeoutMs || DEFAULT_TIMEOUT_MS)
    return this.parseSearchResults(resultText, request.query)
  }

  async fetch(request: { url: string; maxBytes: number; timeoutMs: number; signal: AbortSignal }): Promise<WebFetchResult> {
    const resultText = await this.callTool('extract', {
      url: request.url,
      maxChars: Math.min(request.maxBytes || ANYSEARCH_MAX_FETCH_BYTES, ANYSEARCH_MAX_FETCH_BYTES)
    }, request.signal, request.timeoutMs || DEFAULT_TIMEOUT_MS)
    return this.parseFetchResult(resultText, request)
  }

  /**
   * Call an AnySearch tool via JSON-RPC 2.0.
   * Returns the text content from the first text content item in the response.
   */
  private async callTool(tool: string, arguments_: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

      const res = await fetch(ANYSEARCH_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: arguments_ }
        }),
        signal: controller.signal
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`AnySearch ${tool} failed (${res.status}): ${text.slice(0, 200)}`)
      }

      const jsonRpc = (await res.json()) as {
        result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }
        error?: { code?: number; message?: string }
      }

      if (jsonRpc.error) {
        throw new Error(`AnySearch ${tool} error: ${jsonRpc.error.message || String(jsonRpc.error.code)}`)
      }

      const content = jsonRpc.result?.content ?? []
      const texts = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').filter(Boolean)
      return texts.join('\n') || ''
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Parse the structured search results text from AnySearch.
   * Format: "### N. Title\n- URL: ...\n- snippet..."
   */
  private parseSearchResults(text: string, query: string): WebSearchResult[] {
    if (!text.trim()) return []

    const results: WebSearchResult[] = []
    const entryBlocks = text.split(/(?=^###\s+\d+\.)/m)

    for (const block of entryBlocks) {
      const titleMatch = block.match(/^###\s+\d+\.\s+(.+)$/m)
      const urlMatch = block.match(/^\*\*URL\*\*:\s*(.+)$/im) || block.match(/- \*\*URL\*\*:\s*(.+)$/im)
      const snippetLines: string[] = []
      let inSnippet = false

      for (const line of block.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('###') || trimmed.startsWith('- **URL**') || trimmed.startsWith('- URL') || trimmed.startsWith('*URL*')) continue
        if (trimmed.startsWith('- ') && !trimmed.startsWith('- **URL**')) {
          inSnippet = true
          snippetLines.push(trimmed.replace(/^-\s*/, ''))
        } else if (inSnippet && trimmed) {
          snippetLines.push(trimmed)
        }
      }

      const title = titleMatch?.[1]?.trim() ?? ''
      const url = urlMatch?.[1]?.trim() ?? ''
      if (!url || !title) continue

      results.push({
        url,
        sourceId: sourceIdFor('search', `${query}:${url}:${results.length}`),
        retrievedAt: this.nowIso(),
        title,
        snippet: snippetLines.join(' ').slice(0, 500),
        provider: this.id,
        rank: results.length + 1
      })
    }

    return results.slice(0, DEFAULT_LIMIT)
  }

  /**
   * Parse fetch/extract response from AnySearch.
   * The text content is the extracted page body.
   */
  private parseFetchResult(text: string, request: { url: string; maxBytes: number }): WebFetchResult {
    if (!text.trim()) throw new Error('AnySearch extract returned empty content')

    const bytes = Buffer.byteLength(text, 'utf8')
    const maxBytes = request.maxBytes || ANYSEARCH_MAX_FETCH_BYTES
    const truncated = bytes > maxBytes

    // Try to extract title from the first line
    const firstLine = text.split('\n')[0]?.trim() ?? ''
    const title = firstLine.length < 200 ? firstLine : undefined
    const body = truncated ? text.slice(0, maxBytes) : text

    return {
      url: request.url,
      finalUrl: request.url,
      sourceId: sourceIdFor('fetch', request.url),
      retrievedAt: this.nowIso(),
      title,
      contentType: 'text/plain',
      text: body,
      byteCount: Math.min(bytes, maxBytes),
      truncated
    }
  }
}
