/**
 * Best-effort tool-error reporting from the runtime to the GUI process.
 *
 * The runtime (spawned as a child of the GUI) has no GitHub token and must not
 * reach out to the network. Tool errors are emitted as a single structured
 * stdout line that the GUI's `createLegalworkChildLogCapture` recognizes and
 * forwards to the existing error-report → GitHub issue pipeline.
 *
 * Privacy: the payload carries only the tool name and a truncated error
 * message. It never includes tool arguments (which can contain document/case
 * content), conversation text, or log file contents.
 */

export const LEGALWORK_TOOL_ERROR_PREFIX = 'LEGALWORK_TOOL_ERROR '
export const LEGALWORK_INEFFICIENT_TURN_PREFIX = 'LEGALWORK_INEFFICIENT_TURN '
const MAX_ERROR_LENGTH = 400
const MAX_REPORTS_PER_MINUTE = 20

let windowStartMs = Date.now()
let countInWindow = 0

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`
}

function shouldEmit(nowMs: number): boolean {
  const WINDOW_MS = 60_000
  if (nowMs - windowStartMs >= WINDOW_MS) {
    windowStartMs = nowMs
    countInWindow = 0
  }
  if (countInWindow >= MAX_REPORTS_PER_MINUTE) return false
  countInWindow += 1
  return true
}

export type ToolErrorInfo = {
  threadId: string
  turnId: string
  toolName: string
  error: string
}

/** 测试用：重置限流窗口。 */
export function __resetForTest(): void {
  windowStartMs = Date.now()
  countInWindow = 0
}

/**
 * Emit a structured stdout line the GUI understands. Rate-limited per minute
 * to avoid flooding the report window. Never throws.
 */
export function reportToolErrorNow(info: ToolErrorInfo): void {
  try {
    if (!shouldEmit(Date.now())) return
    const payload = {
      toolName: info.toolName,
      error: truncate(info.error, MAX_ERROR_LENGTH)
    }
    process.stdout.write(`${LEGALWORK_TOOL_ERROR_PREFIX}${JSON.stringify(payload)}\n`)
  } catch {
    // Best-effort: a failed report must never affect the agent loop.
  }
}

export type InefficientTurnInfo = {
  threadId: string
  turnId: string
  steps: number
  toolCalls: number
}

/**
 * Emit a structured stdout line for an "agent inefficient / simple task
 * overcomplicated" signal: the turn ran many steps without completing.
 * Payload carries only step/tool counts — never conversation content.
 */
export function reportInefficientTurnNow(info: InefficientTurnInfo): void {
  try {
    if (!shouldEmit(Date.now())) return
    process.stdout.write(`${LEGALWORK_INEFFICIENT_TURN_PREFIX}${JSON.stringify({
      steps: info.steps,
      toolCalls: info.toolCalls
    })}\n`)
  } catch {
    // Best-effort: a failed report must never affect the agent loop.
  }
}
