import { describe, expect, it } from 'vitest'
import type { ChatBlock, ToolBlock } from '../../agent/types'
import { activeToolOrbState, orbStateForBlock, orbStateForToolName, resolveOrbState } from './orb-state'

function toolBlock(overrides: Partial<ToolBlock>): ToolBlock {
  return {
    kind: 'tool',
    id: 't1',
    summary: 'run: echo hi',
    status: 'running',
    toolKind: 'command_execution',
    ...overrides
  }
}

const reasoningBlock: ChatBlock = { kind: 'reasoning', id: 'r1', text: 'thinking…' }

describe('orbStateForToolName', () => {
  it('maps search tools to searching', () => {
    expect(orbStateForToolName('web_search')).toBe('searching')
    expect(orbStateForToolName('knowledge_search')).toBe('searching')
    expect(orbStateForToolName('grep')).toBe('searching')
  })

  it('maps writing tools to composing', () => {
    expect(orbStateForToolName('write_file')).toBe('composing')
    expect(orbStateForToolName('edit')).toBe('composing')
    expect(orbStateForToolName('resolve_legal_document_template')).toBe('composing')
  })

  it('maps file_change kind to shaping', () => {
    expect(orbStateForToolName('unknown', 'file_change')).toBe('shaping')
  })

  it('falls back to working', () => {
    expect(orbStateForToolName('run_shell', 'command_execution')).toBe('working')
    expect(orbStateForToolName('')).toBe('working')
  })
})

describe('orbStateForBlock', () => {
  it('maps reasoning blocks to solving', () => {
    expect(orbStateForBlock(reasoningBlock)).toBe('solving')
  })

  it('maps active tool blocks by summary tool name', () => {
    expect(
      orbStateForBlock(toolBlock({ summary: 'web_search: query', toolKind: 'tool_call' }))
    ).toBe('searching')
  })

  it('returns null for non-process block kinds', () => {
    const user: ChatBlock = { kind: 'user', id: 'u1', text: 'hi' }
    expect(orbStateForBlock(user)).toBeNull()
  })
})

describe('activeToolOrbState', () => {
  it('finds the first running tool block', () => {
    const blocks: ChatBlock[] = [
      reasoningBlock,
      toolBlock({ id: 't1', summary: 'web_fetch: url', toolKind: 'tool_call' })
    ]
    expect(activeToolOrbState(blocks)).toBe('searching')
  })

  it('returns null when no tool is running', () => {
    expect(activeToolOrbState([reasoningBlock])).toBeNull()
    expect(activeToolOrbState([])).toBeNull()
  })

  it('ignores finished tool blocks', () => {
    const blocks: ChatBlock[] = [
      toolBlock({ id: 't1', summary: 'write_file: x', status: 'success' })
    ]
    expect(activeToolOrbState(blocks)).toBeNull()
  })
})

describe('resolveOrbState', () => {
  const base = { busy: true, liveReasoning: '', waitingForUserInput: false }

  it('returns listening when waiting for user input (highest priority)', () => {
    expect(resolveOrbState({ ...base, waitingForUserInput: true, activeToolName: 'web_search' })).toBe(
      'listening'
    )
  })

  it('prefers a specific active tool over reasoning', () => {
    expect(
      resolveOrbState({ ...base, liveReasoning: 'thinking', activeToolName: 'knowledge_search' })
    ).toBe('searching')
  })

  it('returns solving while reasoning streams', () => {
    expect(resolveOrbState({ ...base, liveReasoning: 'deep thought' })).toBe('solving')
  })

  it('returns working as the default when busy', () => {
    expect(resolveOrbState(base)).toBe('working')
    expect(resolveOrbState({ busy: false, liveReasoning: '', waitingForUserInput: false })).toBe(
      'working'
    )
  })
})
