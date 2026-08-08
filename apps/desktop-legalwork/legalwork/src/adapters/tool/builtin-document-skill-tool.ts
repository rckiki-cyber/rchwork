import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import type { SkillToolsOptions } from './builtin-tool-types.js'
import {
  LEGAL_DOCUMENT_FORMATTING_SKILL_ID,
  hasStructuralOfficeFallbackEvidence,
  markOfficeFallbackEligible
} from './office-fallback-policy.js'

export const DOCUMENT_SKILL_EXECUTE_TOOL_NAME = 'document_skill_execute'
const MAX_OUTPUT_CHARS = 16_000
const MAX_ARG_COUNT = 80
const MAX_ARG_CHARS = 4096
const WORKER_TIMEOUT_MS = 5 * 60 * 1000

const OPERATIONS: Record<string, ReadonlySet<string>> = {
  docx: new Set(['inspect', 'normalize', 'page', 'replace', 'from-markdown', 'template-fill']),
  pptx: new Set(['inspect', 'from-json', 'replace']),
  reference: new Set(['inspect', 'apply']),
  profile: new Set(['profiles', 'apply']),
  legacy: new Set(['convert'])
}

type PythonCandidate = { command: string; prefix: string[] }

export function createDocumentSkillExecuteTool(options: SkillToolsOptions = {}): LocalTool {
  return LocalToolHost.defineTool({
    name: DOCUMENT_SKILL_EXECUTE_TOOL_NAME,
    description:
      'LegalWork document Skill executor. Use for Word/DOCX, legacy DOC conversion, and normal PPTX formatting instead of bash or Office MCP. Runs only the bundled legal-document-formatting workers and returns compact JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['docx', 'pptx', 'reference', 'profile', 'legacy'] },
        operation: { type: 'string' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'CLI arguments after the operation, e.g. ["--input","a.docx","--output","b.docx"]'
        }
      },
      required: ['kind', 'operation'],
      additionalProperties: false
    },
    policy: 'auto',
    toolKind: 'tool_call',
    execute: async (rawArgs, context) => {
      const kind = stringArg(rawArgs.kind)
      const operation = stringArg(rawArgs.operation)
      const args = stringArrayArg(rawArgs.args)
      if (!kind || !OPERATIONS[kind]) {
        return { output: { status: 'error', error: `unsupported document worker kind: ${kind || '(empty)'}` }, isError: true }
      }
      if (!operation || !OPERATIONS[kind]?.has(operation)) {
        return { output: { status: 'error', error: `unsupported ${kind} operation: ${operation || '(empty)'}` }, isError: true }
      }
      if (!args) {
        return { output: { status: 'error', error: 'args must be a bounded string array' }, isError: true }
      }
      const skill = options.skillRuntime?.load(LEGAL_DOCUMENT_FORMATTING_SKILL_ID)
      if (!skill) {
        return { output: { status: 'error', error: 'legal-document-formatting Skill is unavailable' }, isError: true }
      }
      const runner = join(skill.root, 'scripts', 'skill_runner.py')
      try {
        const runnerStat = await stat(runner)
        if (!runnerStat.isFile()) throw new Error('managed document Skill runner is missing')
      } catch (error) {
        return { output: { status: 'error', error: errorMessage(error) }, isError: true }
      }

      const python = await findPython(context.abortSignal)
      if (!python) {
        return {
          output: {
            status: 'error',
            stage: 'runtime',
            error: 'No compatible Python launcher is available for the managed document Skill runtime.',
            office_fallback_allowed: false
          },
          isError: true
        }
      }

      const result = await runProcess(
        python.command,
        [...python.prefix, runner, kind, operation, ...args],
        skill.root,
        context.abortSignal,
        WORKER_TIMEOUT_MS
      )
      if (result.error) {
        return {
          output: { status: 'error', stage: 'runtime', error: result.error, office_fallback_allowed: false },
          isError: true
        }
      }

      const payload = parseWorkerJson(result.stdout)
      if (!payload) {
        return {
          output: {
            status: 'error',
            stage: 'worker',
            error: (result.stderr || result.stdout || 'document worker returned no JSON').slice(-2400),
            office_fallback_allowed: false
          },
          isError: true
        }
      }

      const fallbackTicket = typeof payload.fallback_ticket === 'string' ? payload.fallback_ticket : ''
      if (fallbackTicket) await unlink(fallbackTicket).catch(() => undefined)
      delete payload.fallback_ticket
      delete payload.fallback

      let fallbackAvailable = false
      if (
        payload.status === 'unsupported' &&
        payload.marker === 'LEGALWORK_DOCUMENT_UNSUPPORTED' &&
        hasStructuralOfficeFallbackEvidence(payload.detail)
      ) {
        const reason = stringArg(payload.reason)
        if (reason) {
          markOfficeFallbackEligible(context, { reason, operation: stringArg(payload.operation) || operation })
          fallbackAvailable = true
        }
      }

      const output = {
        ...payload,
        ...(fallbackAvailable ? { fallback_available: true } : { office_fallback_allowed: false })
      }
      return {
        output,
        isError: result.exitCode !== 0 || payload.status === 'error'
      }
    }
  })
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArrayArg(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ARG_COUNT) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length > MAX_ARG_CHARS) return null
    out.push(item)
  }
  return out
}

function pythonCandidates(): PythonCandidate[] {
  const seen = new Set<string>()
  const out: PythonCandidate[] = []
  const add = (command: string | undefined, prefix: string[] = []) => {
    const value = command?.trim()
    if (!value) return
    const id = `${value}\u0000${prefix.join('\u0000')}`
    if (seen.has(id)) return
    seen.add(id)
    out.push({ command: value, prefix })
  }
  add(process.env.LEGALWORK_SKILL_PYTHON)
  add(process.env.LEGALWORK_PYTHON)
  add(process.env.LEGALWORK_OCR_PYTHON)
  add('python3')
  add('python')
  if (process.platform === 'win32') add('py', ['-3'])
  return out
}

async function findPython(signal: AbortSignal): Promise<PythonCandidate | null> {
  for (const candidate of pythonCandidates()) {
    const result = await runProcess(
      candidate.command,
      [...candidate.prefix, '-c', 'import sys; raise SystemExit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)'],
      process.cwd(),
      signal,
      8_000
    )
    if (!result.error && result.exitCode === 0) return candidate
    if (signal.aborted) return null
  }
  return null
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null; error?: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      resolve({ stdout, stderr, exitCode: null, error: errorMessage(error) })
      return
    }
    const append = (current: string, chunk: Buffer | string) => {
      const next = current + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
      return next.length <= MAX_OUTPUT_CHARS ? next : next.slice(-MAX_OUTPUT_CHARS)
    }
    child.stdout.on('data', (chunk: Buffer | string) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer | string) => { stderr = append(stderr, chunk) })
    const finish = (result: { exitCode: number | null; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, ...result })
    }
    const onAbort = () => {
      child.kill()
      finish({ exitCode: null, error: 'document Skill execution aborted' })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error: Error) => finish({ exitCode: null, error: errorMessage(error) }))
    child.on('close', (code: number | null) => {
      finish({
        exitCode: code,
        ...(timedOut ? { error: `document Skill execution timed out after ${timeoutMs}ms` } : {})
      })
    })
  })
}

function parseWorkerJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] ?? '')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // keep scanning older lines in case a library wrote noise after the JSON
    }
  }
  return null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
