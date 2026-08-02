import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { getOrCreateDeviceId } from './device-id'

/**
 * Best-effort automatic error reporting.
 *
 * Legalwork is distributed to third-party lawyers; the author wants to see
 * errors that happen on machines they don't control. The client only POSTs a
 * privacy-safe JSON payload to a publisher-configured endpoint; when no
 * endpoint is configured nothing is sent at all. Failures are always
 * swallowed — error reporting must never affect the app.
 *
 * Privacy: the payload carries the error message (truncated), stack
 * (truncated), category, and installation metadata only. It never includes
 * `detail` (which can contain user paths or case data) or log file contents.
 */

export const ERROR_REPORT_ENDPOINT_ENV = 'LEGALWORK_ERROR_REPORT_URL'
export const ERROR_REPORT_GITHUB_REPO_ENV = 'LEGALWORK_ERROR_REPORT_GITHUB_REPO'
export const ERROR_REPORT_GITHUB_TOKEN_ENV = 'LEGALWORK_ERROR_REPORT_GITHUB_TOKEN'
export const ERROR_REPORT_GITHUB_LABEL_ENV = 'LEGALWORK_ERROR_REPORT_GITHUB_LABEL'

export type ErrorReportPayload = {
  kind: 'error'
  deviceId: string
  version: string
  platform: NodeJS.Platform
  arch: string
  appId: string
  ts: number
  level: 'error'
  category: string
  message: string
  stack?: string
  dedupKey: string
}

type ErrorReportConfig = {
  dataDir: string
  version: string
  platform: NodeJS.Platform
  arch: string
  appId: string
  /** Generic endpoint: POST the JSON payload here. */
  endpoint?: string
  /** GitHub issue reporting: owner/repo, e.g. "acme/legalwork-reports". */
  githubRepo?: string
  /** Minimal-privilege GitHub token (issues:write on the report repo only). */
  githubToken?: string
  /** Optional label(s) applied to created issues. Default ["bug-report"]. */
  githubLabels?: string[]
  /** Path to a JSON config file bundled into the packaged app (resources). */
  configPath?: string
  /** Max reports per time window. Default 10. */
  maxPerWindow?: number
  /** Time window length in ms. Default 10 minutes. */
  windowMs?: number
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
}

/** Shape of the bundled error-report.config.json. */
type ErrorReportFileConfig = {
  githubRepo?: string
  githubToken?: string
  githubLabels?: string[]
  endpoint?: string
}

function readErrorReportFileConfig(path: string | undefined): ErrorReportFileConfig {
  if (!path || !existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ErrorReportFileConfig>
    return {
      githubRepo: typeof raw.githubRepo === 'string' ? raw.githubRepo : undefined,
      githubToken: typeof raw.githubToken === 'string' ? raw.githubToken : undefined,
      endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : undefined,
      githubLabels: Array.isArray(raw.githubLabels)
        ? raw.githubLabels.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : undefined
    }
  } catch {
    return {}
  }
}

type ErrorReportInput = {
  category: string
  message: string
  stack?: string
}

const DEFAULT_MAX_PER_WINDOW = 10
const DEFAULT_WINDOW_MS = 10 * 60 * 1000
const MAX_MESSAGE_LENGTH = 500
const MAX_STACK_LENGTH = 2000

let config: ErrorReportConfig | null = null
let fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)

// Dedup: one report per dedupKey per session.
const seenDedupKeys = new Set<string>()
// Rate limit: sliding count window to keep the receiver from being spammed.
let windowStart = Date.now()
let countInWindow = 0

export function configureErrorReporting(next: ErrorReportConfig): void {
  // The packaged app is double-click launched with no shell env, so the report
  // destination comes from the config file bundled into resources. Runtime env
  // (dev / CI) wins when present; the file is the fallback.
  const file = readErrorReportFileConfig(next.configPath)
  config = {
    ...next,
    githubRepo: next.githubRepo?.trim() || file.githubRepo?.trim() || undefined,
    githubToken: next.githubToken?.trim() || file.githubToken?.trim() || undefined,
    githubLabels: next.githubLabels?.length ? next.githubLabels : file.githubLabels,
    endpoint: next.endpoint?.trim() || file.endpoint?.trim() || undefined
  }
  if (next.fetchImpl) fetchImpl = next.fetchImpl
}

function dedupKeyOf(category: string, message: string): string {
  return createHash('sha1').update(`${category}:${message}`, 'utf8').digest('hex')
}

function shouldReport(dedupKey: string, nowMs: number): boolean {
  if (seenDedupKeys.has(dedupKey)) return false
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS
  const maxPerWindow = config?.maxPerWindow ?? DEFAULT_MAX_PER_WINDOW
  if (nowMs - windowStart >= windowMs) {
    windowStart = nowMs
    countInWindow = 0
  }
  if (countInWindow >= maxPerWindow) return false
  seenDedupKeys.add(dedupKey)
  countInWindow += 1
  return true
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`
}

/**
 * Fire-and-forget error report. Never throws, never blocks. When no report
 * destination is configured this is a no-op. Priority: GitHub issues (when a
 * repo+token are configured) then generic endpoint.
 */
export function reportError(input: ErrorReportInput): void {
  if (!config) return

  const message = truncate(input.message, MAX_MESSAGE_LENGTH)
  const dedupKey = dedupKeyOf(input.category, input.message)
  if (!shouldReport(dedupKey, Date.now())) return

  const payload: ErrorReportPayload = {
    kind: 'error',
    deviceId: getOrCreateDeviceId(config.dataDir),
    version: config.version,
    platform: config.platform,
    arch: config.arch,
    appId: config.appId,
    ts: Date.now(),
    level: 'error',
    category: input.category,
    message,
    ...(input.stack ? { stack: truncate(input.stack, MAX_STACK_LENGTH) } : {}),
    dedupKey
  }

  const githubRepo = config.githubRepo?.trim()
  const githubToken = config.githubToken?.trim()
  if (githubRepo && githubToken) {
    void sendGitHubIssue(payload, githubRepo, githubToken)
    return
  }
  const endpoint = config.endpoint?.trim()
  if (endpoint) {
    void fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    }).catch(() => {
      // Best-effort: a failed report must never surface.
    })
  }
}

/**
 * Report as a GitHub issue in the publisher's repo. `githubToken` is a
 * minimal-privilege token (issues:write on that repo only) — see docs. The
 * dedupKey is embedded in the body so the same error is easy to spot.
 */
function sendGitHubIssue(payload: ErrorReportPayload, repo: string, token: string): void {
  const title = `${payload.category}: ${payload.message}`.slice(0, 255)
  const labels = config?.githubLabels?.length ? config.githubLabels : ['bug-report']
  const body = [
    'Auto-reported error (legalwork).',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```'
  ].join('\n')

  void fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({ title, body, labels }),
    signal: AbortSignal.timeout(8000)
  }).catch(() => {
    // Best-effort: a failed report must never surface.
  })
}

/** Test helper: clear dedup/rate-limit state so a new burst can be reported. */
export function __resetForTest(): void {
  seenDedupKeys.clear()
  windowStart = Date.now()
  countInWindow = 0
  config = null
}
