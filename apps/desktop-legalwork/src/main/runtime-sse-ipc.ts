import type { IpcMain, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'
import type { AppSettingsV1 } from '../shared/app-settings'
import { legalworkThreadEventsPath } from '../shared/legalwork-endpoints'
import { sseStartPayloadSchema, streamIdSchema } from './ipc/app-ipc-schemas'
import type { JsonSettingsStore } from './settings-store'
import { getRuntimeBaseUrlForSettings, runtimeAuthHeaders } from './runtime/legalwork-adapter'

type SseControllerState = {
  controller: AbortController
  ownerWebContentsId: number
  stoppedByClient: boolean
  /** Batched event queue per connection, flushed on a timer so a huge
   * backlog (a finished research thread replays thousands of events) is
   * pushed to the renderer in chunks instead of one giant IPC burst that
   * saturates the renderer and drops the tail events. */
  eventBatch: unknown[]
  batchTimer: ReturnType<typeof setInterval> | null
}

const SSE_RECONNECT_BASE_MS = 750
const SSE_RECONNECT_MAX_MS = 5_000
const SSE_START_TIMEOUT_MS = 15_000
// 重连次数上限：防止 runtime 反复崩溃时无限重连空转。60 次 × ≤5s 退避 ≈ 数分钟。
const SSE_MAX_RECONNECTS = 60
const SSE_BATCH_FLUSH_MS = 40
const SSE_BATCH_MAX_EVENTS = 120


const sseControllers = new Map<string, SseControllerState>()

function flushSseEventBatch(state: SseControllerState, wc: WebContents, streamId: string): void {
  if (state.batchTimer) {
    clearInterval(state.batchTimer)
    state.batchTimer = null
  }
  if (state.eventBatch.length === 0) return
  const batch = state.eventBatch
  state.eventBatch = []
  if (wc.isDestroyed()) return
  wc.send('runtime:sse-event', { streamId, data: batch.length === 1 ? batch[0] : batch })
}

function scheduleSseEventBatchFlush(state: SseControllerState, wc: WebContents, streamId: string): void {
  if (state.batchTimer) return
  state.batchTimer = setInterval(() => flushSseEventBatch(state, wc, streamId), SSE_BATCH_FLUSH_MS)
}

function queueSseEvent(state: SseControllerState, wc: WebContents, streamId: string, payload: unknown): void {
  state.eventBatch.push(payload)
  if (state.eventBatch.length >= SSE_BATCH_MAX_EVENTS) {
    flushSseEventBatch(state, wc, streamId)
    return
  }
  scheduleSseEventBatchFlush(state, wc, streamId)
}

function safeSend(
  webContents: WebContents,
  channel: 'runtime:sse-event' | 'runtime:sse-end' | 'runtime:sse-error',
  payload: unknown
): void {
  if (webContents.isDestroyed()) return
  webContents.send(channel, payload)
}

function abortSseState(state: SseControllerState, options?: { stoppedByClient?: boolean }): void {
  state.stoppedByClient = options?.stoppedByClient === true
  if (state.batchTimer) {
    clearInterval(state.batchTimer)
    state.batchTimer = null
  }
  state.controller.abort()
}

export function stopRuntimeSseForWebContents(webContentsId: number): void {
  for (const state of sseControllers.values()) {
    if (state.ownerWebContentsId === webContentsId) {
      abortSseState(state)
    }
  }
}

export function stopAllRuntimeSse(): void {
  for (const state of sseControllers.values()) {
    abortSseState(state)
  }
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function parseSseData(raw: string): { data: unknown; event?: string; id?: string } | null {
  const lines = raw.split('\n')
  const dataLines: string[] = []
  let eventName = ''
  let eventId = ''
  for (const line of lines) {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
    if (normalized.startsWith('event:')) {
      eventName = normalized.slice(6).trim()
      continue
    }
    if (normalized.startsWith('id:')) {
      eventId = normalized.slice(3).trim()
      continue
    }
    if (normalized.startsWith('data:')) {
      dataLines.push(normalized.slice(5).trimStart())
    }
  }
  if (!dataLines.length) return null
  const payload = dataLines.join('\n')
  try {
    return {
      data: JSON.parse(payload),
      ...(eventName ? { event: eventName } : {}),
      ...(eventId ? { id: eventId } : {})
    }
  } catch {
    return null
  }
}

function takeSseBlock(buffer: string): { block: string; rest: string } | null {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return null
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return {
      block: buffer.slice(0, crlf),
      rest: buffer.slice(crlf + 4)
    }
  }
  return {
    block: buffer.slice(0, lf),
    rest: buffer.slice(lf + 2)
  }
}

function coerceSsePayload(parsed: { data: unknown; event?: string; id?: string }): Record<string, unknown> {
  const payload: Record<string, unknown> =
    parsed.data && typeof parsed.data === 'object'
      ? { ...(parsed.data as Record<string, unknown>) }
      : { value: parsed.data }
  if (typeof payload.seq !== 'number' && parsed.id && /^\d+$/.test(parsed.id)) {
    payload.seq = Number(parsed.id)
  }
  if (typeof payload.kind !== 'string' && parsed.event) {
    payload.kind = parsed.event
  }
  return payload
}

function isFatalSseStatus(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
}

async function fetchSseWithStartTimeout(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Response> {
  const attempt = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    attempt.abort()
  }, timeoutMs)
  const onAbort = (): void => {
    attempt.abort()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetch(url, { signal: attempt.signal, headers })
  } catch (error) {
    if (timedOut) {
      throw new Error('sse start timeout')
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export function registerRuntimeSseIpc(options: {
  ipcMain: IpcMain
  store: JsonSettingsStore
  ensureRuntime: (settings: AppSettingsV1) => Promise<void>
  logError: (category: string, message: string, detail?: unknown) => void
}): void {
  const { ipcMain, store, ensureRuntime, logError } = options
  ipcMain.handle('runtime:sse:start', async (event, args: unknown) => {
    const request = sseStartPayloadSchema.parse(args)
    const s = await store.load()
    await ensureRuntime(s)
    const requestedId = request.streamId?.trim() ?? ''
    const id = requestedId || randomUUID()
    const existing = sseControllers.get(id)
    if (existing) {
      abortSseState(existing, { stoppedByClient: true })
      sseControllers.delete(id)
    }
    const ac = new AbortController()
    const state: SseControllerState = {
      controller: ac,
      ownerWebContentsId: event.sender.id,
      stoppedByClient: false,
      eventBatch: [],
      batchTimer: null
    }
    sseControllers.set(id, state)
    const base = getRuntimeBaseUrlForSettings(s)
    const onSenderDestroyed = (): void => {
      abortSseState(state, { stoppedByClient: true })
    }
    event.sender.once('destroyed', onSenderDestroyed)

    ;(async () => {
      const wc = event.sender
      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      runtimeAuthHeaders(s).forEach((value, key) => {
        headers[key] = value
      })
      let nextSinceSeq = request.sinceSeq
      let reconnectDelayMs = SSE_RECONNECT_BASE_MS
      let reconnectAttempts = 0
      try {
        while (!state.stoppedByClient && !ac.signal.aborted) {
          const url = new URL(`${base}${legalworkThreadEventsPath(request.threadId)}`)
          url.searchParams.set('since_seq', String(nextSinceSeq))
          const requestHeaders = { ...headers }
          if (nextSinceSeq > 0) {
            requestHeaders['Last-Event-ID'] = String(nextSinceSeq)
          } else {
            delete requestHeaders['Last-Event-ID']
          }
          try {
            const res = await fetchSseWithStartTimeout(url, requestHeaders, ac.signal, SSE_START_TIMEOUT_MS)
            if (!res.ok || !res.body) {
              if (isFatalSseStatus(res.status)) {
                flushSseEventBatch(state, wc, id)
                safeSend(wc, 'runtime:sse-error', { streamId: id, status: res.status })
                logError('sse', `SSE connection failed for thread ${request.threadId}`, {
                  status: res.status,
                  streamId: id
                })
                return
              }
              await sleepWithAbort(reconnectDelayMs, ac.signal)
              reconnectDelayMs = Math.min(reconnectDelayMs * 2, SSE_RECONNECT_MAX_MS)
              continue
            }
            reconnectDelayMs = SSE_RECONNECT_BASE_MS
            reconnectAttempts = 0
            const reader = res.body.getReader()
            const dec = new TextDecoder()
            let buffer = ''
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += dec.decode(value, { stream: true })
              let next: { block: string; rest: string } | null
              while ((next = takeSseBlock(buffer)) !== null) {
                const block = next.block
                buffer = next.rest
                const parsed = parseSseData(block)
                if (parsed !== null) {
                  const payload = coerceSsePayload(parsed)
                  if (typeof payload.seq === 'number') {
                    nextSinceSeq = Math.max(nextSinceSeq, payload.seq)
                  }
                  queueSseEvent(state, wc, id, payload)
                }
              }
            }
            buffer += dec.decode()
            const trailing = buffer.trim()
            if (trailing) {
              const parsed = parseSseData(trailing)
              if (parsed !== null) {
                const payload = coerceSsePayload(parsed)
                if (typeof payload.seq === 'number') {
                  nextSinceSeq = Math.max(nextSinceSeq, payload.seq)
                }
                queueSseEvent(state, wc, id, payload)
              }
            }
            // Stream read to completion: flush anything still batched.
            flushSseEventBatch(state, wc, id)
          } catch (e) {
            if (state.stoppedByClient || ac.signal.aborted) return
            const msg = e instanceof Error ? e.message : String(e)
            // 连接中断类错误（网络失败、runtime 重启导致流被掐断）属于可恢复场景，
            // 按退避策略自动重连而不是直接上报；重连超过上限才上报，避免刷屏。
            const isInterruption =
              /sse start timeout/i.test(msg) ||
              /fetch failed/i.test(msg) ||
              /network/i.test(msg) ||
              /terminated/i.test(msg) ||
              /premature close/i.test(msg) ||
              /socket hang up/i.test(msg) ||
              /ECONNRESET/i.test(msg) ||
              /aborted/i.test(msg)
            if (isInterruption) {
              reconnectAttempts += 1
              if (reconnectAttempts > SSE_MAX_RECONNECTS) {
                flushSseEventBatch(state, wc, id)
                safeSend(wc, 'runtime:sse-error', { streamId: id, message: msg })
                logError('sse', `SSE stream error for thread ${request.threadId} (reconnect exhausted): ${msg}`, {
                  streamId: id
                })
                return
              }
              await sleepWithAbort(reconnectDelayMs, ac.signal)
              reconnectDelayMs = Math.min(reconnectDelayMs * 2, SSE_RECONNECT_MAX_MS)
              continue
            }
            flushSseEventBatch(state, wc, id)
            safeSend(wc, 'runtime:sse-error', { streamId: id, message: msg })
            logError('sse', `SSE stream error for thread ${request.threadId}: ${msg}`, { streamId: id })
            return
          }
        }
      } finally {
        event.sender.removeListener('destroyed', onSenderDestroyed)
        flushSseEventBatch(state, wc, id)
        if (!state.stoppedByClient) {
          safeSend(wc, 'runtime:sse-end', { streamId: id })
        }
        if (state.batchTimer) {
          clearInterval(state.batchTimer)
          state.batchTimer = null
        }
        // Only remove this connection's own state. On a same-id restart the
        // map entry may already be a brand-new SseControllerState — deleting
        // by id here would orphan the live replacement.
        if (sseControllers.get(id) === state) {
          sseControllers.delete(id)
        }
      }
    })()

    return { streamId: id }
  })

  ipcMain.handle('runtime:sse:stop', async (_, streamId: unknown) => {
    const normalizedStreamId = streamIdSchema.parse(streamId)
    const state = sseControllers.get(normalizedStreamId)
    if (state) {
      abortSseState(state, { stoppedByClient: true })
    }
    return true
  })
}
