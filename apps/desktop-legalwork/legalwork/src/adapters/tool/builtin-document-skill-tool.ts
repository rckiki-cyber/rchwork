import { existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { LocalTool } from './local-tool-host.js'
import type { SkillToolsOptions } from './builtin-tool-types.js'
import {
  DOCUMENT_SKILL_EXECUTE_TOOL_NAME,
  LEGAL_DOCUMENT_FORMATTING_SKILL_ID,
  hasStructuralOfficeFallbackEvidence,
  markOfficeFallbackEligible
} from './office-fallback-policy.js'

export { DOCUMENT_SKILL_EXECUTE_TOOL_NAME } from './office-fallback-policy.js'
const MAX_OUTPUT_CHARS = 16_000
const MAX_ARG_COUNT = 80
const MAX_ARG_CHARS = 4096
const MAX_INLINE_CONTENT_CHARS = 200_000
const MAX_PATH_CHARS = 4096
const WORKER_TIMEOUT_MS = 5 * 60 * 1000
const HISTORY_PLACEHOLDER_RE = /\[(?:cache hygiene|history-only compression|historical (?:argument|context)(?: note)?)[^\]]*(?:omitted|abbreviated|placeholder|preview)[^\]]*\]/i
const DOCUMENT_PROFILES = new Set(['legal-default', 'academic', 'litigation'])
const PATH_ARGUMENTS = new Set([
  '--input',
  '--output',
  '--reference',
  '--spec',
  '--structure-spec',
  '--values'
])

const OPERATIONS: Record<string, ReadonlySet<string>> = {
  docx: new Set(['inspect', 'normalize', 'page', 'replace', 'from-markdown', 'template-fill']),
  pdf: new Set(['from-docx']),
  xlsx: new Set(['inspect', 'from-json', 'replace']),
  pptx: new Set(['inspect', 'from-json', 'replace']),
  reference: new Set(['inspect', 'apply']),
  profile: new Set(['profiles', 'apply']),
  legacy: new Set(['convert'])
}

type PythonCandidate = { command: string; prefix: string[] }

export function createDocumentSkillExecuteTool(options: SkillToolsOptions = {}): LocalTool {
  return {
    name: DOCUMENT_SKILL_EXECUTE_TOOL_NAME,
    description:
      'Create or edit Office/PDF files with LegalWork\'s local document Skill instead of bash or Office MCP. Word uses docx/from-markdown: complete Markdown in content, outputPath=.docx. PDF from an existing Word file uses pdf/from-docx: args=["--input","report.docx","--output","report.pdf"]. PPT uses pptx/from-json: complete slide JSON in content, outputPath=.pptx. content must be complete final source; never pass cache-hygiene text, previews, ellipses, omitted/truncated markers, or placeholders. Valid pairs: docx=inspect|normalize|page|replace|from-markdown|template-fill; pdf=from-docx; xlsx=inspect|from-json|replace; pptx=inspect|from-json|replace; reference=inspect|apply; profile=profiles|apply; legacy=convert. Do not probe with help/list or search for another PDF/PPT tool.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['docx', 'pdf', 'xlsx', 'pptx', 'reference', 'profile', 'legacy'] },
        operation: {
          type: 'string',
          enum: [
            'inspect',
            'normalize',
            'page',
            'replace',
            'from-markdown',
            'from-docx',
            'template-fill',
            'from-json',
            'apply',
            'profiles',
            'convert'
          ],
          description:
            'Operation must match kind. For new Word documents use docx/from-markdown; legacy/convert is only for old .doc/.xls/.ppt files.'
        },
        content: {
          type: 'string',
          description:
            'Complete final inline Markdown for docx/from-markdown, or complete JSON object with a non-empty slides array for pptx/from-json. Never use a preview, ellipsis, cache-hygiene/history marker, omitted/truncated note, or placeholder.'
        },
        outputPath: {
          type: 'string',
          description:
            'Destination .docx or .pptx path for inline document creation. Relative paths resolve inside the thread workspace.'
        },
        profile: {
          type: 'string',
          enum: ['legal-default', 'academic', 'litigation'],
          description: 'Optional Word formatting profile for inline docx/from-markdown.'
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Advanced worker arguments after the operation, e.g. ["--input","a.docx","--output","b.docx"]. Paths may be relative to the thread workspace.'
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
      const content = optionalStringArg(rawArgs.content)
      const outputPath = optionalStringArg(rawArgs.outputPath)
      const profile = optionalStringArg(rawArgs.profile)
      if (rawArgs.content !== undefined && content === undefined) {
        return { output: { status: 'error', error: 'content must be a string' }, isError: true }
      }
      if (rawArgs.outputPath !== undefined && outputPath === undefined) {
        return { output: { status: 'error', error: 'outputPath must be a string' }, isError: true }
      }
      if (rawArgs.profile !== undefined && profile === undefined) {
        return { output: { status: 'error', error: 'profile must be a string' }, isError: true }
      }
      if (!kind || !OPERATIONS[kind]) {
        return { output: { status: 'error', error: `unsupported document worker kind: ${kind || '(empty)'}` }, isError: true }
      }
      if (!operation || !OPERATIONS[kind]?.has(operation)) {
        return {
          output: {
            status: 'error',
            error:
              `unsupported ${kind} operation: ${operation || '(empty)'}; ` +
              `supported operations: ${[...(OPERATIONS[kind] ?? [])].join(', ')}`
          },
          isError: true
        }
      }
      if (!args) {
        return { output: { status: 'error', error: 'args must be a bounded string array' }, isError: true }
      }
      if (content !== undefined && content.length > MAX_INLINE_CONTENT_CHARS) {
        return {
          output: {
            status: 'error',
            error: `content exceeds ${MAX_INLINE_CONTENT_CHARS} characters`
          },
          isError: true
        }
      }
      if (content !== undefined && !content.trim()) {
        return {
          output: { status: 'error', error: 'content must not be empty for inline document creation' },
          isError: true
        }
      }
      if (content !== undefined && HISTORY_PLACEHOLDER_RE.test(content)) {
        return {
          output: {
            status: 'error',
            error:
              'content contains a history/cache-hygiene placeholder. Send the complete final Markdown正文 verbatim in this call; do not send a preview, omitted/truncated marker, or meta-comment.'
          },
          isError: true
        }
      }
      const supportsInlineContent =
        (kind === 'docx' && operation === 'from-markdown') ||
        (kind === 'pptx' && operation === 'from-json')
      if (content !== undefined && !supportsInlineContent) {
        return {
          output: {
            status: 'error',
            error: 'inline content is supported only for docx/from-markdown or pptx/from-json'
          },
          isError: true
        }
      }
      if (content !== undefined && !outputPath) {
        return {
          output: {
            status: 'error',
            error: 'outputPath is required for inline docx/from-markdown or pptx/from-json content'
          },
          isError: true
        }
      }
      if (outputPath !== undefined && content === undefined) {
        return {
          output: {
            status: 'error',
            error: 'outputPath is a top-level option only for inline docx/from-markdown or pptx/from-json; use args otherwise'
          },
          isError: true
        }
      }
      const expectedInlineExtension = kind === 'pptx' ? '.pptx' : '.docx'
      if (
        outputPath &&
        (outputPath.length > MAX_PATH_CHARS || !outputPath.toLowerCase().endsWith(expectedInlineExtension))
      ) {
        return {
          output: {
            status: 'error',
            error: `outputPath must be a bounded ${expectedInlineExtension} path`
          },
          isError: true
        }
      }
      if (content !== undefined && args.length > 0) {
        return {
          output: {
            status: 'error',
            error: 'args cannot be combined with inline content; use content, outputPath, and profile only'
          },
          isError: true
        }
      }
      if (kind === 'pptx' && operation === 'from-json' && content !== undefined) {
        const validationError = inlinePptJsonError(content)
        if (validationError) {
          return {
            output: { status: 'error', error: validationError },
            isError: true
          }
        }
      }
      if (profile && !DOCUMENT_PROFILES.has(profile)) {
        return {
          output: { status: 'error', error: `unsupported document profile: ${profile}` },
          isError: true
        }
      }
      if (profile && (content === undefined || kind !== 'docx')) {
        return {
          output: {
            status: 'error',
            error: 'profile is a top-level option only for inline docx/from-markdown; use args for other operations'
          },
          isError: true
        }
      }
      if (
        kind === 'docx' &&
        operation === 'from-markdown' &&
        content === undefined &&
        (!hasArg(args, '--input') || !hasArg(args, '--output'))
      ) {
        return {
          output: {
            status: 'error',
            error: 'docx/from-markdown requires inline content + outputPath, or args containing --input and --output'
          },
          isError: true
        }
      }
      if (
        kind === 'pptx' &&
        operation === 'from-json' &&
        content === undefined &&
        (!hasArg(args, '--input') || !hasArg(args, '--output'))
      ) {
        return {
          output: {
            status: 'error',
            error: 'pptx/from-json requires inline content + outputPath, or args containing --input and --output'
          },
          isError: true
        }
      }
      if (
        kind === 'pptx' &&
        operation === 'from-json' &&
        inputArgLooksLikeInlineJson(args)
      ) {
        return {
          output: {
            status: 'error',
            error: 'pptx/from-json --input expects a JSON file path, not JSON text; pass complete JSON via content with outputPath instead'
          },
          isError: true
        }
      }
      if (
        kind === 'pdf' &&
        operation === 'from-docx' &&
        (!hasArg(args, '--input') || !hasArg(args, '--output'))
      ) {
        return {
          output: {
            status: 'error',
            error: 'pdf/from-docx requires args containing --input and --output'
          },
          isError: true
        }
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

      const python = await findPython(skill.root, context.abortSignal)
      if (!python) {
        return {
          output: {
            status: 'error',
            stage: 'runtime',
            error: isPackagedSkillRoot(skill.root)
              ? 'Bundled Office Python runtime is missing or cannot start. Reinstall LegalWork; end-user runtime setup is disabled.'
              : 'No compatible Python launcher is available for the development document Skill runtime.',
            office_fallback_allowed: false
          },
          isError: true
        }
      }

      let prepared: Awaited<ReturnType<typeof prepareDocumentWorkerArgs>>
      try {
        prepared = await prepareDocumentWorkerArgs({
          args,
          content,
          outputPath,
          profile,
          kind,
          workspace: context.workspace
        })
      } catch (error) {
        return { output: { status: 'error', error: errorMessage(error) }, isError: true }
      }
      const result = await runProcess(
        python.command,
        [...python.prefix, runner, kind, operation, ...prepared.workerArgs],
        skill.root,
        context.abortSignal,
        WORKER_TIMEOUT_MS
      ).finally(prepared.cleanup)
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

      // Compatibility cleanup for older worker builds. Fallback authorization
      // itself is runtime-memory based; model-created files cannot unlock MCP.
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
        kind,
        ...(fallbackAvailable ? { fallback_available: true } : { office_fallback_allowed: false })
      }
      return {
        output,
        isError: result.exitCode !== 0 || payload.status === 'error'
      }
    }
  }
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalStringArg(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : undefined
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

function hasArg(args: string[], name: string): boolean {
  const index = args.indexOf(name)
  return index >= 0 && Boolean(args[index + 1])
}

function inputArgLooksLikeInlineJson(args: string[]): boolean {
  const index = args.indexOf('--input')
  if (index < 0) return false
  const value = args[index + 1]?.trim() ?? ''
  return value.startsWith('{') || value.startsWith('[')
}

function inlinePptJsonError(content: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return 'pptx/from-json content must be valid JSON'
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'pptx/from-json content must be a JSON object with a non-empty slides array'
  }
  const slides = (parsed as Record<string, unknown>).slides
  if (!Array.isArray(slides) || slides.length === 0) {
    return 'pptx/from-json content must contain a non-empty slides array'
  }
  if (slides.some((slide) => !slide || typeof slide !== 'object' || Array.isArray(slide))) {
    return 'pptx/from-json slides must contain JSON objects'
  }
  return undefined
}

function resolveWorkerPathArgs(args: string[], workspace: string): string[] {
  const out = [...args]
  for (let index = 0; index < out.length - 1; index += 1) {
    const flag = out[index]
    if (!flag || !PATH_ARGUMENTS.has(flag)) continue
    const value = out[index + 1]
    if (!value || value.startsWith('-')) continue
    out[index + 1] = resolveWorkspacePath(value, workspace)
    index += 1
  }
  return out
}

export async function prepareDocumentWorkerArgs(input: {
  args: string[]
  content?: string
  outputPath?: string
  profile?: string
  kind?: string
  workspace: string
}): Promise<{ workerArgs: string[]; cleanup: () => Promise<void> }> {
  if (input.content === undefined || !input.outputPath) {
    return {
      workerArgs: resolveWorkerPathArgs(input.args, input.workspace),
      cleanup: async () => undefined
    }
  }
  const resolvedOutputPath = resolveInlineOutputPath(input.outputPath, input.workspace)
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'legalwork-document-source-'))
  const sourcePath = join(temporaryRoot, input.kind === 'pptx' ? 'source.json' : 'source.md')
  try {
    await writeFile(sourcePath, input.content, 'utf8')
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  const workerArgs = [
      '--input',
      sourcePath,
      '--output',
      resolvedOutputPath
    ]
  if (input.kind !== 'pptx') {
    workerArgs.push('--profile', input.profile || 'legal-default')
  }
  return {
    workerArgs,
    cleanup: async () => rm(temporaryRoot, { recursive: true, force: true })
  }
}

function resolveInlineOutputPath(value: string, workspace: string): string {
  const trimmed = value.trim()
  if (isAbsolute(trimmed) || trimmed === '~' || trimmed.startsWith('~/')) {
    return resolveWorkspacePath(trimmed, workspace)
  }
  const root = resolve(workspace.trim() || process.cwd())
  const absolute = resolve(root, trimmed)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error('relative outputPath must stay inside the thread workspace')
  }
  return absolute
}

function resolveWorkspacePath(value: string, workspace: string): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2))
  if (isAbsolute(trimmed)) return trimmed
  return resolve(workspace.trim() || process.cwd(), trimmed)
}

function packagedResourcesRoot(skillRoot: string): string {
  return join(skillRoot, '..', '..')
}

function bundledOfficePythonPath(skillRoot: string): string {
  const runtimeRoot = join(packagedResourcesRoot(skillRoot), 'office-runtime', 'python')
  return process.platform === 'win32'
    ? join(runtimeRoot, 'python.exe')
    : join(runtimeRoot, 'bin', 'python3')
}

function isPackagedSkillRoot(skillRoot: string): boolean {
  const resourcesRoot = packagedResourcesRoot(skillRoot)
  return existsSync(join(resourcesRoot, 'app.asar')) || existsSync(join(resourcesRoot, 'app.asar.unpacked'))
}

function pythonCandidates(skillRoot: string): PythonCandidate[] {
  const bundled = bundledOfficePythonPath(skillRoot)
  if (existsSync(bundled)) {
    return [{ command: bundled, prefix: [] }]
  }
  if (isPackagedSkillRoot(skillRoot)) {
    // Never fall back to system Python or runtime pip on an end-user install.
    return []
  }

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
  add(process.env.LEGALWORK_OFFICE_PYTHON)
  add(process.env.LEGALWORK_SKILL_PYTHON)
  add(process.env.LEGALWORK_PYTHON)
  add(process.env.LEGALWORK_OCR_PYTHON)
  add('python3')
  add('python')
  if (process.platform === 'win32') add('py', ['-3'])
  return out
}

async function findPython(skillRoot: string, signal: AbortSignal): Promise<PythonCandidate | null> {
  for (const candidate of pythonCandidates(skillRoot)) {
    const result = await runProcess(
      candidate.command,
      [...candidate.prefix, '-c', 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,10) else 1)'],
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
    let child: ChildProcess
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
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr = append(stderr, chunk) })
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
