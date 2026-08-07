export type ParsedRateLimit = {
  rateLimited: boolean
  message: string
  retryAfterSeconds?: number
}

const RATE_LIMIT_RE =
  /\b(rate[-\s]?limit(?:ed|ing)?|too many requests|quota exceeded|request limit|(?:http|status)\s*:?\s*429)\b/i
const RETRY_AFTER_RE =
  /\b(?:retry[-\s]?after|try again in|wait)\s*:?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?)?\b/i

/**
 * 数据/正文类字段。扫描限流信号时跳过这些键：工具结果里真正代表"发生限流"
 * 的总是短错误消息；而正文、数据、对话等长内容里"提到"限流词不代表本调用
 * 被限流（例如 bash 脚本 stdout 里打印了其他请求的 429 错误、thread_read
 * 返回的对话记录里嵌有历史报错）。继续扫描会把成功结果误判成 rate_limited。
 */
const CONTENT_KEYS = new Set([
  'text',
  'content',
  'output',
  'conversation',
  'data',
  'records',
  'result',
  'results',
  'contextText',
  'summary',
  'original',
  'body',
  'html',
  'transcript',
  'logs',
  'stdout',
  'stderr'
])

/** 限流信号是短消息；超过该长度的字符串视为数据而非错误信号。 */
const MAX_ERROR_SIGNAL_CHARS = 400

export function parseRateLimitedToolResult(output: unknown): ParsedRateLimit | null {
  const text = collectText(output).join('\n').trim()
  if (!text || !RATE_LIMIT_RE.test(text)) return null
  const retryAfter = parseRetryAfterSeconds(text)
  return {
    rateLimited: true,
    message: compactRateLimitMessage(text),
    ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {})
  }
}

export function normalizeRateLimitedToolOutput(output: unknown): {
  output: unknown
  isError: boolean
  rateLimited: boolean
} {
  // 结果明确成功（exit_code 0 / status completed|success|ok|done）时绝不判限流。
  // 这修复了"bash 脚本成功执行、但 stdout 恰好提到 HTTP 429/quota"被整体误标
  // 为 rate_limited 的误报（本线程导出轮 analyze_errors.py 等即因此被误标）。
  if (isExplicitSuccess(output)) return { output, isError: false, rateLimited: false }
  const parsed = parseRateLimitedToolResult(output)
  if (!parsed) return { output, isError: false, rateLimited: false }
  return {
    output: {
      code: 'rate_limited',
      rate_limited: true,
      error: parsed.message,
      ...(parsed.retryAfterSeconds !== undefined ? { retry_after_seconds: parsed.retryAfterSeconds } : {}),
      original: output
    },
    isError: true,
    rateLimited: true
  }
}

function isExplicitSuccess(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.exit_code === 0) return true
  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : ''
  return status === 'completed' || status === 'success' || status === 'ok' || status === 'done'
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return []
  if (typeof value === 'string') return value.length <= MAX_ERROR_SIGNAL_CHARS ? [value] : []
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (Array.isArray(value)) return value.flatMap((entry) => collectText(entry, depth + 1))
  if (typeof value !== 'object') return []
  const out: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CONTENT_KEYS.has(key)) continue
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
      if (typeof child === 'string' && child.length > MAX_ERROR_SIGNAL_CHARS) continue
      out.push(`${key}: ${String(child)}`)
      continue
    }
    out.push(...collectText(child, depth + 1))
  }
  return out
}

function parseRetryAfterSeconds(text: string): number | undefined {
  const match = RETRY_AFTER_RE.exec(text)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value < 0) return undefined
  const unit = (match[2] ?? 's').toLowerCase()
  if (unit.startsWith('ms') || unit.startsWith('millisecond')) return Math.ceil(value / 1000)
  if (unit.startsWith('m') && !unit.startsWith('ms')) return Math.ceil(value * 60)
  return Math.ceil(value)
}

function compactRateLimitMessage(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= 360) return compact
  return `${compact.slice(0, 357).trim()}...`
}
