import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { extname } from 'node:path'
import { mkdirSync } from 'node:fs'

type JsonObject = Record<string, unknown>

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type CodexServerRequest = {
  id: string | number
  method: string
  params: JsonObject
}

export type CodexAppServerRpcOptions = {
  binaryPath: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
}

export type CodexNotificationHandler = (method: string, params: JsonObject) => void
export type CodexServerRequestHandler = (
  request: CodexServerRequest
) => Promise<unknown> | unknown

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const STDERR_TAIL_LIMIT = 4_000

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function rpcErrorMessage(error: unknown): string {
  const record = asObject(error)
  const message = typeof record.message === 'string' ? record.message : ''
  const code = typeof record.code === 'number' || typeof record.code === 'string'
    ? ` (${record.code})`
    : ''
  return message ? `${message}${code}` : 'Codex app-server request failed'
}

/**
 * Small JSONL client for the official `codex app-server` stdio protocol.
 * Authentication storage and token refresh remain owned by Codex.
 */
export class CodexAppServerRpc {
  private readonly options: CodexAppServerRpcOptions
  private readonly pending = new Map<string | number, PendingRequest>()
  private readonly notificationHandlers = new Set<CodexNotificationHandler>()
  private readonly serverRequestHandlers = new Set<CodexServerRequestHandler>()
  private child: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private nextId = 1
  private stderrTail = ''

  constructor(options: CodexAppServerRpcOptions) {
    this.options = options
  }

  onNotification(handler: CodexNotificationHandler): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onServerRequest(handler: CodexServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler)
    return () => this.serverRequestHandlers.delete(handler)
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    await this.start()
    return this.rawRequest<T>(method, params, timeoutMs)
  }

  async start(): Promise<void> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return
    if (this.startPromise) return this.startPromise
    const task = this.startOnce()
    this.startPromise = task
    try {
      await task
    } finally {
      if (this.startPromise === task) this.startPromise = null
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.killed) return
    child.kill()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
  }

  private async startOnce(): Promise<void> {
    this.stderrTail = ''
    const codexHome = this.options.env?.CODEX_HOME?.trim()
    if (codexHome) mkdirSync(codexHome, { recursive: true })
    const isNodeEntrypoint = ['.js', '.cjs', '.mjs'].includes(
      extname(this.options.binaryPath).toLowerCase()
    )
    const command = isNodeEntrypoint ? process.execPath : this.options.binaryPath
    const args = [
      ...(isNodeEntrypoint ? [this.options.binaryPath] : []),
      'app-server',
      '--listen',
      'stdio://'
    ]
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...(isNodeEntrypoint ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        ...(this.options.env ?? {})
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT)
    })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.handleLine(line))
    child.on('error', (error) => this.failAll(error))
    child.on('exit', (code, signal) => {
      const suffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ''
      this.failAll(new Error(
        signal
          ? `Codex app-server exited with signal ${signal}${suffix}`
          : `Codex app-server exited with code ${code ?? 'unknown'}${suffix}`
      ))
      if (this.child === child) this.child = null
    })
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn)
        reject(error)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
    await this.rawRequest('initialize', {
      clientInfo: {
        name: 'legalwork',
        title: 'Legalwork',
        version: '0.3.9'
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    })
    this.write({ method: 'initialized', params: {} })
  }

  private rawRequest<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const id = this.nextId++
    const timeout = timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, timeout)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })
      try {
        this.write({ method, id, params: params ?? {} })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private write(message: JsonObject): void {
    const child = this.child
    if (!child || child.exitCode !== null || child.killed) {
      throw new Error('Codex app-server is not running')
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    let message: JsonObject
    try {
      message = asObject(JSON.parse(line) as unknown)
    } catch {
      return
    }
    const id = typeof message.id === 'string' || typeof message.id === 'number'
      ? message.id
      : undefined
    if (id !== undefined && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(id)
      if (message.error !== undefined && message.error !== null) {
        pending.reject(new Error(rpcErrorMessage(message.error)))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    const method = typeof message.method === 'string' ? message.method : ''
    if (!method) return
    const params = asObject(message.params)
    if (id !== undefined) {
      void this.handleServerRequest({ id, method, params })
      return
    }
    for (const handler of this.notificationHandlers) handler(method, params)
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    for (const handler of this.serverRequestHandlers) {
      try {
        const result = await handler(request)
        if (result !== undefined) {
          this.write({ id: request.id, result })
          return
        }
      } catch (error) {
        this.write({
          id: request.id,
          error: {
            code: -32_000,
            message: error instanceof Error ? error.message : String(error)
          }
        })
        return
      }
    }
    this.write({
      id: request.id,
      error: { code: -32_601, message: `Unsupported server request: ${request.method}` }
    })
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
