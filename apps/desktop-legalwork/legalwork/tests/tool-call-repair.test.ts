import { describe, expect, it } from 'vitest'

import { repairDispatchToolArguments } from '../src/loop/tool-call-repair.js'

describe('tool call dispatch repair', () => {
  it('flattens common wrapper argument objects', () => {
    const repaired = repairDispatchToolArguments({
      tool_name: 'read',
      arguments: { path: 'src/app.ts' }
    })

    expect(repaired.arguments).toEqual({ path: 'src/app.ts' })
    expect(repaired.notes).toEqual(['flattened arguments wrapper'])
  })

  it('parses fenced JSON from wrapper strings', () => {
    const repaired = repairDispatchToolArguments({
      input: '```json\n{"query":"auth"}\n```'
    })

    expect(repaired.arguments).toEqual({ query: 'auth' })
    expect(repaired.notes).toEqual(['flattened input wrapper'])
  })

  it('scavenges a JSON object from a single string argument', () => {
    const repaired = repairDispatchToolArguments({
      query: 'please use {"path":"README.md"} now'
    })

    expect(repaired.arguments).toEqual({ path: 'README.md' })
    expect(repaired.notes).toEqual(['scavenged JSON object from query'])
  })

  it('truncates very large non-file-change strings without touching file edits', () => {
    const repaired = repairDispatchToolArguments(
      { transcript: 'a'.repeat(32) },
      { maxStringBytes: 8 }
    )
    expect(String(repaired.arguments.transcript)).toContain('[truncated by Legalwork tool argument repair]')
    expect(repaired.notes).toEqual(['truncated 1 oversized argument string(s)'])

    const preserved = repairDispatchToolArguments(
      { content: 'a'.repeat(32) },
      { toolKind: 'file_change', maxStringBytes: 8 }
    )
    expect(preserved.arguments).toEqual({ content: 'a'.repeat(32) })
    expect(preserved.notes).toEqual([])
  })

  it('repairs a bash call missing the required command field', () => {
    // 模型在超长上下文尾部可能发出只含元数据、缺 command 的无效 bash 调用
    const repaired = repairDispatchToolArguments(
      { type: 'meta', session: 'some-session', date: '2026-08-02', model: 'deepseek-v4-flash' },
      { toolName: 'bash' }
    )

    expect(String(repaired.arguments.command)).toContain('Invalid bash call')
    expect(repaired.notes[0]).toContain('repaired invalid bash call missing "command"')
    // 参数详情放 note，且命令本身是纯常量（不含模型参数，避免命令注入）
    expect(String(repaired.arguments.command)).not.toContain('some-session')
  })

  it('leaves a valid bash call with command untouched', () => {
    const repaired = repairDispatchToolArguments(
      { command: 'ls -la' },
      { toolName: 'bash' }
    )

    expect(repaired.arguments).toEqual({ command: 'ls -la' })
    expect(repaired.notes).toEqual([])
  })

  it('does not inject command into non-bash tools missing command', () => {
    const repaired = repairDispatchToolArguments(
      { path: '/tmp/x' },
      { toolName: 'read' }
    )

    expect(repaired.arguments).toEqual({ path: '/tmp/x' })
    expect(repaired.arguments.command).toBeUndefined()
  })
})
