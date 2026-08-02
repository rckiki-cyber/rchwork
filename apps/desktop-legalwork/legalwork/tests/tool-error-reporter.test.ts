import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEGALWORK_TOOL_ERROR_PREFIX,
  LEGALWORK_INEFFICIENT_TURN_PREFIX,
  reportToolErrorNow,
  reportInefficientTurnNow,
  __resetForTest
} from '../src/cli/tool-error-reporter.js'

describe('tool-error-reporter', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    __resetForTest()
  })

  afterEach(() => {
    writeSpy.mockRestore()
  })

  it('emits a structured stdout line with tool name and error', () => {
    reportToolErrorNow({ threadId: 't', turnId: 'u', toolName: 'read', error: 'file not found' })
    const written = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    expect(written).toContain(LEGALWORK_TOOL_ERROR_PREFIX)
    const payload = JSON.parse(written.slice(LEGALWORK_TOOL_ERROR_PREFIX.length))
    expect(payload).toEqual({ toolName: 'read', error: 'file not found' })
  })

  it('truncates long error messages', () => {
    reportToolErrorNow({ threadId: 't', turnId: 'u', toolName: 'bash', error: 'x'.repeat(2000) })
    const written = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    const payload = JSON.parse(written.slice(LEGALWORK_TOOL_ERROR_PREFIX.length))
    expect(payload.error.length).toBeLessThanOrEqual(401)
  })

  it('never includes tool arguments in the payload', () => {
    reportToolErrorNow({ threadId: 't', turnId: 'u', toolName: 'write', error: 'permission denied' })
    const written = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    const payload = JSON.parse(written.slice(LEGALWORK_TOOL_ERROR_PREFIX.length))
    expect(Object.keys(payload)).toEqual(['toolName', 'error'])
    expect(payload.arguments).toBeUndefined()
  })

  it('rate-limits bursts to avoid flooding', () => {
    // 同分钟内连续触发超过上限
    const LIMIT = 20
    for (let i = 0; i < LIMIT + 5; i += 1) {
      reportToolErrorNow({ threadId: 't', turnId: 'u', toolName: 'tool', error: `err-${i}` })
    }
    const written = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    const lines = written.split('\n').filter((l: string) => l.startsWith(LEGALWORK_TOOL_ERROR_PREFIX))
    expect(lines.length).toBe(LIMIT)
  })

  it('emits inefficient-turn signal with steps and tool calls', () => {
    reportInefficientTurnNow({ threadId: 't', turnId: 'u', steps: 30, toolCalls: 12 })
    const written = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    expect(written).toContain(LEGALWORK_INEFFICIENT_TURN_PREFIX)
    const payload = JSON.parse(written.slice(LEGALWORK_INEFFICIENT_TURN_PREFIX.length))
    expect(payload).toEqual({ steps: 30, toolCalls: 12 })
  })

  it('inefficient-turn payload never includes conversation content', () => {
    reportInefficientTurnNow({ threadId: 't', turnId: 'u', steps: 40, toolCalls: 20 })
    const written = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')
    const payload = JSON.parse(written.slice(LEGALWORK_INEFFICIENT_TURN_PREFIX.length))
    expect(Object.keys(payload)).toEqual(['steps', 'toolCalls'])
  })
})
