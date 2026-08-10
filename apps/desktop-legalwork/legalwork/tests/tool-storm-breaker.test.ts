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

function mcpCall(toolId: string, argumentsValue: Record<string, unknown>): ToolCallLike {
  return {
    callId: Math.random().toString(36),
    toolName: 'mcp_call',
    arguments: { toolId, arguments: argumentsValue }
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

  it('suppresses the first consecutive retry after an identical call succeeds', () => {
    const breaker = new ToolStormBreaker()
    const first = call({ path: '论文/算法行政.pdf' })

    expect(breaker.inspect(first).suppress).toBe(false)
    breaker.observeResult(first, false)

    const duplicate = breaker.inspect(call({ path: '论文/算法行政.pdf' }))
    expect(duplicate.suppress).toBe(true)
    expect(duplicate.reason).toContain('already completed successfully')
  })

  it('allows the same check after a different semantic action', () => {
    const breaker = new ToolStormBreaker()
    const first = call({ path: 'report.docx' })
    breaker.inspect(first)
    breaker.observeResult(first, false)

    const edit: ToolCallLike = {
      callId: 'edit-1',
      toolName: 'edit',
      toolKind: 'file_change',
      arguments: { path: 'report.md', oldText: 'a', newText: 'b' }
    }
    expect(breaker.inspect(edit).suppress).toBe(false)
    breaker.observeResult(edit, false)

    expect(breaker.inspect(call({ path: 'report.docx' })).suppress).toBe(false)
  })

  it('allows lost read evidence to be recovered after compaction without clearing other guards', () => {
    const breaker = new ToolStormBreaker()
    const readCall = call({ path: '论文/全文.txt' })
    breaker.inspect(readCall)
    breaker.observeResult(readCall, false)
    breaker.onCompaction()

    expect(breaker.inspect(call({ path: '论文/全文.txt' })).suppress).toBe(false)

    const echoCall: ToolCallLike = {
      callId: 'echo-1',
      toolName: 'echo',
      arguments: { text: 'same' }
    }
    breaker.inspect(echoCall)
    breaker.observeResult(echoCall, false)
    breaker.onCompaction()
    expect(breaker.inspect({ ...echoCall, callId: 'echo-2' }).suppress).toBe(true)
  })

  it('deduplicates concurrent and completed legal-database queries for the whole turn', () => {
    const breaker = new ToolStormBreaker()
    const first = mcpCall('yuandian-case/yuandian_rh_qwal_search', {
      qw: '食品药品 宽严相济',
      top_k: 50
    })
    expect(breaker.inspect(first).suppress).toBe(false)
    expect(breaker.inspect({ ...first, callId: 'parallel-duplicate' }).reason).toContain('already running')

    breaker.observeResult(first, false)
    const unrelated = mcpCall('yuandian-law/yuandian_rh_fg_search', { keyword: '食品安全法' })
    expect(breaker.inspect(unrelated).suppress).toBe(false)
    breaker.observeResult(unrelated, false)

    expect(breaker.inspect({ ...first, callId: 'later-duplicate' }).reason).toContain('already completed')
  })

  it('requires a changed query after a legal-database failure', () => {
    const breaker = new ToolStormBreaker()
    const failed = mcpCall('pkulaw-case-semantic-search/search_case', { text: '宽严相济' })
    breaker.inspect(failed)
    breaker.observeResult(failed, true)

    expect(breaker.inspect({ ...failed, callId: 'unchanged' }).suppress).toBe(true)
    expect(breaker.inspect(mcpCall(
      'pkulaw-case-semantic-search/search_case',
      { text: '食药犯罪 宽严相济' }
    )).suppress).toBe(false)
  })

  it('caps distinct case-research calls in a turn', () => {
    const breaker = new ToolStormBreaker({ researchLimits: { case: 2 } })
    expect(breaker.inspect(mcpCall('yuandian-case/search', { qw: '查询一' })).suppress).toBe(false)
    expect(breaker.inspect(mcpCall('yuandian-case/search', { qw: '查询二' })).suppress).toBe(false)
    const capped = breaker.inspect(mcpCall('yuandian-case/search', { qw: '查询三' }))
    expect(capped.suppress).toBe(true)
    expect(capped.reason).toContain('per-turn limit of 2')
  })
})
