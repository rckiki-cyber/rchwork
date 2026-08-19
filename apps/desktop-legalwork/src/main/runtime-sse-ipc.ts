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
  batchTimer: ReturnType<typeof setTimeout> | null
}

const SSE_RECONNECT_BASE_MS = 750
const SSE_RECONNECT_MAX_MS = 5_000
const SSE_START_TIMEOUT_MS = 15_000
// 重连次数上限：防止 runtime 反复崩溃时无限重连空转。60 次 × ≤5s 退避 ≈ 数分钟。
const SSE_MAX_RECONNECTS = 60
// Match a 60 Hz display instead of holding live text in 40 ms (25 fps)
// chunks. Backlog protection still comes from the bounded batch size below.
const SSE_BATCH_FLUSH_MS = 16
const SSE_BATCH_MAX_EVENTS = 60


const sseControllers = new Map<string, SseControllerState>()

function flushSseEventBatch(state: SseControllerState, wc: WebContents, streamId: string): void {
  if (state.batchTimer) {
    clearTimeout(state.batchTimer)
    state.batchTimer = null
  }
  if (state.eventBatch.length === 0) return
  // Drain at most one bounded slice per timer tick.  The fetch reader can
  // consume a persisted backlog much faster than Electron can render it; an
  // immediate flush every N events merely turns that backlog into a burst of
  // IPC messages.  Keeping the remainder queued gives the renderer a paint
  // opportunity between slices.
  const batch = state.eventBatch.splice(0, SSE_BATCH_MAX_EVENTS)
  if (wc.isDestroyed()) return
  wc.send('runtime:sse-event', { streamId, data: batch.length === 1 ? batch[0] : batch })
  if (state.eventBatch.length > 0) {
    scheduleSseEventBatchFlush(state, wc, streamId)
  }
}

function scheduleSseEventBatchFlush(state: SseControllerState, wc: WebContents, streamId: string): void {
  if (state.batchTimer) return
  state.batchTimer = setTimeout(() => flushSseEventBatch(state, wc, streamId), SSE_BATCH_FLUSH_MS)
}

function mergeAdjacentDelta(previous: unknown, current: unknown): unknown | null {
  if (!previous || typeof previous !== 'object' || !current || typeof current !== 'object') return null
  const previousEvent = previous as Record<string, unknown>
  const currentEvent = current as Record<string, unknown>
  const kind = currentEvent.kind
  if (
    kind !== previousEvent.kind ||
    (kind !== 'assistant_text_delta' && kind !== 'assistant_reasoning_delta')
  ) return null
  const previousItem = previousEvent.item
  const currentItem = currentEvent.item
  if (!previousItem || typeof previousItem !== 'object' || !currentItem || typeof currentItem !== 'object') {
    return null
  }
  const previousItemRecord = previousItem as Record<string, unknown>
  const currentItemRecord = currentItem as Record<string, unknown>
  if (
    previousItemRecord.id !== currentItemRecord.id ||
    typeof previousItemRecord.text !== 'string' ||
    typeof currentItemRecord.text !== 'string'
  ) return null
  return {
    ...previousEvent,
    ...currentEvent,
    item: {
      ...previousItemRecord,
      ...currentItemRecord,
      text: previousItemRecord.text + currentItemRecord.text
    }
  }
}

function queueSseEvent(state: SseControllerState, wc: WebContents, streamId: string, payload: unknown): void {
  const lastIndex = state.eventBatch.length - 1
  if (lastIndex >= 0) {
    const merged = mergeAdjacentDelta(state.eventBatch[lastIndex], payload)
    if (merged) {
      state.eventBatch[lastIndex] = merged
      scheduleSseEventBatchFlush(state, wc, streamId)
      return
    }
  }
  state.eventBatch.push(payload)
  scheduleSseEventBatchFlush(state, wc, streamId)
}

function flushAllSseEventBatches(state: SseControllerState, wc: WebContents, streamId: string): void {
  if (state.batchTimer) {
    clearTimeout(state.batchTimer)
    state.batchTimer = null
  }
  while (state.eventBatch.length > 0 && !wc.isDestroyed()) {
    const batch = state.eventBatch.splice(0, SSE_BATCH_MAX_EVENTS)
    wc.send('runtime:sse-event', { streamId, data: batch.length === 1 ? batch[0] : batch })
  }
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
    clearTimeout(state.batchTimer)
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
  /** Test-only timing override; production uses the bounded defaults above. */
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}): void {
  const { ipcMain, store, ensureRuntime, logError } = options
  const reconnectBaseMs = options.reconnectBaseMs ?? SSE_RECONNECT_BASE_MS
  const reconnectMaxMs = options.reconnectMaxMs ?? SSE_RECONNECT_MAX_MS
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
    const onSenderDestroyed = (): void => {
      abortSseState(state, { stoppedByClient: true })
    }
    event.sender.once('destroyed', onSenderDestroyed)

    ;(async () => {
      const wc = event.sender
      let nextSinceSeq = request.sinceSeq
      let reconnectDelayMs = reconnectBaseMs
      let reconnectAttempts = 0
      const recoverRuntime = async (): Promise<void> => {
        if (state.stoppedByClient || ac.signal.aborted) return
        try {
          await ensureRuntime(await store.load())
        } catch {
          // The reconnect budget owns the terminal user-visible error. A
          // failed recovery probe here is expected while a child restarts.
        }
      }
      try {
        while (!state.stoppedByClient && !ac.signal.aborted) {
          // Reload on every attempt: ensureRuntime can reclaim a conflicting
          // port and persist a new one, and settings changes can rotate the
          // runtime token while the renderer keeps the same stream id.
          const connectionSettings = await store.load()
          const base = getRuntimeBaseUrlForSettings(connectionSettings)
          const headers: Record<string, string> = { Accept: 'text/event-stream' }
          runtimeAuthHeaders(connectionSettings).forEach((value, key) => {
            headers[key] = value
          })
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
                flushAllSseEventBatches(state, wc, id)
                safeSend(wc, 'runtime:sse-error', { streamId: id, status: res.status })
                logError('sse', `SSE connection failed for thread ${request.threadId}`, {
                  status: res.status,
                  streamId: id
                })
                return
              }
              reconnectAttempts += 1
              if (reconnectAttempts > SSE_MAX_RECONNECTS) {
                flushAllSseEventBatches(state, wc, id)
                safeSend(wc, 'runtime:sse-error', {
                  streamId: id,
                  status: res.status,
                  message: `sse unavailable after ${SSE_MAX_RECONNECTS} reconnects`
                })
                return
              }
              await recoverRuntime()
              await sleepWithAbort(reconnectDelayMs, ac.signal)
              reconnectDelayMs = Math.min(reconnectDelayMs * 2, reconnectMaxMs)
              continue
            }
            const reader = res.body.getReader()
            const dec = new TextDecoder()
            let buffer = ''
            let receivedEventOnConnection = false
            const markConnectionHealthy = (): void => {
              if (receivedEventOnConnection) return
              receivedEventOnConnection = true
              reconnectDelayMs = reconnectBaseMs
              reconnectAttempts = 0
            }
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
                  markConnectionHealthy()
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
                markConnectionHealthy()
                const payload = coerceSsePayload(parsed)
                if (typeof payload.seq === 'number') {
                  nextSinceSeq = Math.max(nextSinceSeq, payload.seq)
                }
                queueSseEvent(state, wc, id, payload)
              }
            }
            // The connection may be restarted immediately. Keep backlog
            // delivery paced instead of synchronously flooding the renderer.
            scheduleSseEventBatchFlush(state, wc, id)
            if (!receivedEventOnConnection) {
              reconnectAttempts += 1
              if (reconnectAttempts > SSE_MAX_RECONNECTS) {
                flushAllSseEventBatches(state, wc, id)
                safeSend(wc, 'runtime:sse-error', {
                  streamId: id,
                  message: `sse closed before delivering events ${SSE_MAX_RECONNECTS} times`
                })
                return
              }
              await recoverRuntime()
              await sleepWithAbort(reconnectDelayMs, ac.signal)
              reconnectDelayMs = Math.min(reconnectDelayMs * 2, reconnectMaxMs)
            }
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
                flushAllSseEventBatches(state, wc, id)
                safeSend(wc, 'runtime:sse-error', { streamId: id, message: msg })
                logError('sse', `SSE stream error for thread ${request.threadId} (reconnect exhausted): ${msg}`, {
                  streamId: id
                })
                return
              }
              await recoverRuntime()
              await sleepWithAbort(reconnectDelayMs, ac.signal)
              reconnectDelayMs = Math.min(reconnectDelayMs * 2, reconnectMaxMs)
              continue
            }
            flushAllSseEventBatches(state, wc, id)
            safeSend(wc, 'runtime:sse-error', { streamId: id, message: msg })
            logError('sse', `SSE stream error for thread ${request.threadId}: ${msg}`, { streamId: id })
            return
          }
        }
      } finally {
        event.sender.removeListener('destroyed', onSenderDestroyed)
        if (state.stoppedByClient) {
          state.eventBatch = []
        } else {
          flushAllSseEventBatches(state, wc, id)
        }
        if (!state.stoppedByClient) {
          safeSend(wc, 'runtime:sse-end', { streamId: id })
        }
        if (state.batchTimer) {
          clearTimeout(state.batchTimer)
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
