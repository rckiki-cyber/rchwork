import { describe, expect, it } from 'vitest'
import { Router } from './router.js'
import { startNodeHttpServer } from './node-http-server.js'

describe('Node HTTP streaming adapter', () => {
  it('flushes response headers before the first streaming body chunk is available', async () => {
    const router = new Router()
    let releaseBody: (() => void) | undefined
    router.add('GET', '/events', () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'))
          controller.close()
        }
      }
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    }))
    const server = await startNodeHttpServer({ router, host: '127.0.0.1', port: 0 })
    const responsePromise = fetch(`http://${server.host}:${server.port}/events`)

    try {
      const headersArrived = await Promise.race([
        responsePromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))
      ])
      expect(headersArrived).toBe(true)
    } finally {
      releaseBody?.()
      await responsePromise.catch(() => undefined)
      await server.close()
    }
  })
})
