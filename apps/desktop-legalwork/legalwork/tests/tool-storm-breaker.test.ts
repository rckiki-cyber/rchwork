import { describe, expect, it } from 'vitest'
import { ToolStormBreaker } from '../src/loop/tool-storm-breaker.js'
import type { ToolCallLike } from '../src/ports/tool-host.js'

function call(argumentsValue: Record<string, unknown>): ToolCallLike {
  return {
    callId: Math.random().toString(36),
    toolName: 'read',
    arguments: argumentsValue
  }
}

describe('ToolStormBreaker', () => {
  it('suppresses the third identical tool call in a turn', () => {
    const breaker = new ToolStormBreaker()

    expect(breaker.inspect(call({ path: 'src/a.ts' })).suppress).toBe(false)
    expect(breaker.inspect(call({ path: 'src/a.ts' })).suppress).toBe(false)
    const third = breaker.inspect(call({ path: 'src/a.ts' }))

    expect(third.suppress).toBe(true)
    expect(third.reason).toContain('identical arguments 3 times')
  })

  it('canonicalizes argument key order', () => {
    const breaker = new ToolStormBreaker()

    expect(breaker.inspect(call({ path: 'src/a.ts', offset: 10 })).suppress).toBe(false)
    expect(breaker.inspect(call({ offset: 10, path: 'src/a.ts' })).suppress).toBe(false)
    expect(breaker.inspect(call({ path: 'src/a.ts', offset: 10 })).suppress).toBe(true)
  })

  it('allows a read after a file-changing call resets read-only history', () => {
    const breaker = new ToolStormBreaker()

    expect(breaker.inspect(call({ path: 'src/a.ts' })).suppress).toBe(false)
    expect(breaker.inspect(call({ path: 'src/a.ts' })).suppress).toBe(false)
    expect(
      breaker.inspect({
        callId: 'mutate',
        toolName: 'write',
        toolKind: 'file_change',
        arguments: { path: 'src/a.ts', content: 'new' }
      }).suppress
    ).toBe(false)
    expect(breaker.inspect(call({ path: 'src/a.ts' })).suppress).toBe(false)
  })

  it('suppresses the first unchanged retry after an OfficeCLI error', () => {
    const breaker = new ToolStormBreaker()
    const officeCall: ToolCallLike = {
      callId: 'office-1',
      toolName: 'mcp_officecli_officecli',
      arguments: { command: ['set', '/tmp/report.docx', '/footer'] }
    }

    expect(breaker.inspect(officeCall).suppress).toBe(false)
    breaker.observeResult(officeCall, true)

    const retry = breaker.inspect({ ...officeCall, callId: 'office-2' })
    expect(retry.suppress).toBe(true)
    expect(retry.reason).toContain('already failed with identical arguments')
  })

  it('allows a corrected OfficeCLI command after an error', () => {
    const breaker = new ToolStormBreaker()
    const failed: ToolCallLike = {
      callId: 'office-1',
      toolName: 'mcp_officecli_officecli',
      arguments: { command: ['set', '/tmp/report.docx', '/footer'] }
    }
    breaker.inspect(failed)
    breaker.observeResult(failed, true)

    expect(breaker.inspect({
      ...failed,
      callId: 'office-2',
      arguments: { command: ['add', '/tmp/report.docx', '/body', '--type', 'footer'] }
    }).suppress).toBe(false)
  })
})
