import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export type LogLevel = 'error' | 'warn' | 'info'
export type ManagedLogFilePrefix = 'legalwork'

type LoggerConfig = {
  /** Directory where log files are stored. */
  dir: string
  /** Whether logging is enabled. */
  enabled: boolean
  /** Delete log files older than this many days. */
  retentionDays: number
}

let cfg: LoggerConfig = { dir: '', enabled: true, retentionDays: 2 }
const MANAGED_LOG_FILE_PREFIXES: ManagedLogFilePrefix[] = ['legalwork']

export function configureLogger(config: Partial<LoggerConfig>): void {
  cfg = { ...cfg, ...config }
}

function logFileName(prefix: ManagedLogFilePrefix, timestamp: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${prefix}-${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())}.log`
}

function isManagedLogFile(entry: string): boolean {
  return MANAGED_LOG_FILE_PREFIXES.some(
    (prefix) => entry.startsWith(`${prefix}-`) && entry.endsWith('.log')
  )
}

/**
 * Best-effort prune of old log files. Runs on every write so it stays
 * tidy without a dedicated timer.
 */
async function pruneOldLogs(): Promise<void> {
  try {
    const entries = await readdir(cfg.dir)
    const cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000
    for (const entry of entries) {
      if (!isManagedLogFile(entry)) continue
      try {
        const info = await stat(join(cfg.dir, entry))
        if (info.mtimeMs < cutoff) {
          await unlink(join(cfg.dir, entry))
        }
      } catch {
        /* skip unreadable files */
      }
    }
  } catch {
    /* directory may not exist yet — that's fine */
  }
}

export async function appendManagedLogLine(
  prefix: ManagedLogFilePrefix,
  line: string
): Promise<void> {
  if (!cfg.enabled || !cfg.dir) return

  const text = line.endsWith('\n') ? line : `${line}\n`

  try {
    await mkdir(cfg.dir, { recursive: true })
    await appendFile(join(cfg.dir, logFileName(prefix, new Date())), text, 'utf8')
    // prune after write — cheap since most writes succeed pruning
    await pruneOldLogs()
  } catch {
    /* never crash the app because of logging */
  }
}

async function writeLogLine(level: LogLevel, category: string, message: string): Promise<void> {
  const stamp = new Date().toISOString()
  const line = `[${stamp}] [${level.toUpperCase()}] [${category}] ${message}\n`
  await appendManagedLogLine('legalwork', line)
}

type ErrorReporter = (input: { category: string; message: string; stack?: string }) => void
let reportErrors: ErrorReporter | null = null

/**
 * Dependency injection point for error reporting (wired by index.ts).
 * Keeps the logger a pure logging module with no network dependency; the
 * reporter is optional and best-effort.
 */
export function setLogErrorReporter(fn: ErrorReporter | null): void {
  reportErrors = fn
}

function extractStack(detail: unknown): string | undefined {
  if (typeof detail === 'object' && detail !== null && 'stack' in detail) {
    const stack = (detail as { stack?: unknown }).stack
    if (typeof stack === 'string' && stack.length > 0) return stack
  }
  return undefined
}

/**
 * Pull a short, user-data-free cause out of an error detail for the report
 * message. Many call sites pass `{ message: <error code/reason> }` (e.g.
 * EADDRINUSE) which is the actionable signal but would otherwise be dropped
 * from the report (only the fixed message + stack are shared).
 *
 * Privacy: only a Node-style error code (EADDRINUSE, ECONNREFUSED, ENOENT, …)
 * or a clearly non-PII short reason is allowed through. Absolute paths, IP
 * addresses, file names, and free-form content are stripped — those must never
 * reach the external report.
 */
const REPORT_CAUSE_CODE_PATTERN = /(?:^|\s)(E[A-Z0-9_]{2,}|ERR_[A-Z0-9_]+)\b/
const REPORT_CAUSE_MAX = 80

function extractReportCause(detail: unknown): string | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined
  const raw = (detail as { message?: unknown }).message
  if (typeof raw !== 'string') return undefined
  const message = raw.trim()
  if (!message) return undefined

  // Fast path: a Node error code is the clean actionable signal. It may appear
  // at the start ("ENOENT: ...") or after a prefix like "listen EADDRINUSE:".
  const codeMatch = message.match(REPORT_CAUSE_CODE_PATTERN)
  if (codeMatch) return codeMatch[1].slice(0, REPORT_CAUSE_MAX)

  // Fallback: allow a very short reason only if it contains no PII markers.
  if (message.length <= REPORT_CAUSE_MAX) {
    const lower = message.toLowerCase()
    const hasPii =
      /[a-z]:[\\/]|\/(?:users?|home|desktop|documents|downloads|applications|tmp)\b/i.test(lower) ||
      /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(lower) ||
      /\.(?:docx?|pdf|txt|md|xlsx?|pptx?|png|jpg|jpeg)\b/i.test(message) ||
      /[\\/][^\\/\s]{3,}\.[a-z0-9]{1,5}$/i.test(message)
    if (!hasPii) return message.slice(0, REPORT_CAUSE_MAX)
  }

  return undefined
}

export function logError(category: string, message: string, detail?: unknown): void {
  const full = detail !== undefined
    ? `${message} — detail: ${safeStringify(detail)}`
    : message
  void writeLogLine('error', category, full)
  // Automatic error reporting (silent, best-effort). Only a safe subset is
  // shared — the message, stack, and a short PII-free cause. Never the full
  // `detail`, which may hold user data.
  try {
    const cause = extractReportCause(detail)
    // Dedup: skip when the cause adds nothing beyond the top-level message
    // (either contains the other). This avoids "<msg>: <msg>…suffix" noise.
    const redundant = cause !== undefined && (
      cause === message ||
      message.includes(cause) ||
      cause.includes(message)
    )
    const reportMessage = cause !== undefined && !redundant
      ? `${message}: ${cause}`
      : message
    reportErrors?.({ category, message: reportMessage, stack: extractStack(detail) })
  } catch {
    /* reporting must never throw */
  }
}

export function logWarn(category: string, message: string, detail?: unknown): void {
  const full = detail !== undefined
    ? `${message} — detail: ${safeStringify(detail)}`
    : message
  void writeLogLine('warn', category, full)
}

export function logInfo(category: string, message: string): void {
  void writeLogLine('info', category, message)
}

/**
 * On startup, prune old logs immediately and log the action.
 */
export async function pruneOnStartup(): Promise<void> {
  await pruneOldLogs()
  logInfo('logger', `Pruned logs older than ${cfg.retentionDays} day(s) on startup`)
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'string') return value.slice(0, 2000)
    return JSON.stringify(value, null, 2).slice(0, 2000)
  } catch {
    return String(value).slice(0, 2000)
  }
}
