import { describe, expect, it } from 'vitest'
import type { ChatBlock } from '../../agent/types'
import { deriveTurnSections } from './derive-turn-sections'
import type { Turn } from './message-timeline-turns'

function sections(blocks: ChatBlock[]) {
  return deriveTurnSections({
    turn: { blocks } satisfies Turn,
    isProcessing: false,
    liveProcessText: '',
    liveContent: '',
    workspaceRoot: '/tmp'
  })
}

function processingSections(input: {
  blocks?: ChatBlock[]
  liveProcessText?: string
  liveContent?: string
}) {
  return deriveTurnSections({
    turn: { blocks: input.blocks ?? [] } satisfies Turn,
    isProcessing: true,
    liveProcessText: input.liveProcessText ?? '',
    liveContent: input.liveContent ?? '',
    workspaceRoot: '/tmp'
  })
}

describe('deriveTurnSections', () => {
  it('renders the final assistant answer as content even when reasoning was persisted after it', () => {
    const result = sections([
      { kind: 'assistant', id: 'answer', text: '你好！' },
      { kind: 'reasoning', id: 'reasoning', text: 'The user greeted me.' }
    ])

    expect(result.assistantContentBlocks).toEqual([
      { kind: 'assistant', id: 'answer', text: '你好！' }
    ])
    expect(result.processBlocks.map((block) => block.kind)).toEqual(['reasoning'])
  })

  it('keeps the full answer when reasoning and a short wrap-up were persisted after it', () => {
    const result = sections([
      {
        kind: 'tool',
        id: 'tool_search',
        summary: 'web_search',
        status: 'success',
        toolKind: 'tool_call'
      },
      { kind: 'reasoning', id: 'reasoning-main', text: '现在整理完整行情。' },
      { kind: 'assistant', id: 'full-answer', text: '这是包含价格表、来源和购买建议的完整正文。' },
      { kind: 'reasoning', id: 'reasoning-wrap', text: '回答已经完成。' },
      { kind: 'assistant', id: 'wrap-up', text: '以上即行情汇总。' }
    ])

    expect(result.assistantContentBlocks.map((block) => block.id)).toEqual([
      'full-answer',
      'wrap-up'
    ])
    expect(result.assistantContentBlocks.map((block) => block.text).join('\n')).toContain('完整正文')
  })

  it('does not discard a substantial report written before a later validation tool', () => {
    const fullReport = [
      '## 完整法律调研报告',
      '',
      '这是已经形成的完整分析正文，包含争议焦点、现行规范、裁判观点、论证过程和结论。'.repeat(8),
      '',
      '- 结论一：正文必须保留。',
      '- 结论二：后续校验不应覆盖正文。',
      '- 结论三：最终收尾只能作为补充。'
    ].join('\n')
    const result = sections([
      {
        kind: 'tool',
        id: 'tool_search',
        summary: 'web_search',
        status: 'success',
        toolKind: 'tool_call'
      },
      { kind: 'assistant', id: 'full-report', text: fullReport },
      { kind: 'reasoning', id: 'reasoning-validate', text: '再核对一个来源。' },
      {
        kind: 'tool',
        id: 'tool_validate',
        summary: 'web_fetch',
        status: 'success',
        toolKind: 'tool_call'
      },
      { kind: 'assistant', id: 'wrap-up', text: '报告已交付。' }
    ])

    expect(result.assistantContentBlocks.map((block) => block.id)).toEqual([
      'full-report',
      'wrap-up'
    ])
    expect(result.processBlocks.map((block) => block.id)).toEqual([
      'tool_search',
      'reasoning-validate',
      'tool_validate'
    ])
  })

  it('keeps short progress prose in the process timeline instead of dropping it', () => {
    const result = sections([
      { kind: 'assistant', id: 'progress', text: '我先核对一下来源。' },
      {
        kind: 'tool',
        id: 'tool_search',
        summary: 'web_search',
        status: 'success',
        toolKind: 'tool_call'
      },
      { kind: 'assistant', id: 'answer', text: '这是最终回答。' }
    ])

    expect(result.assistantContentBlocks.map((block) => block.id)).toEqual(['answer'])
    expect(result.processBlocks.map((block) => block.id)).toEqual(['progress', 'tool_search'])
  })

  it('uses the last assistant text as final content without duplicating it in process work', () => {
    const result = sections([
      { kind: 'assistant', id: 'preface', text: '我先检查一下。' },
      {
        kind: 'tool',
        id: 'tool_1',
        summary: 'read',
        status: 'success',
        toolKind: 'tool_call'
      }
    ])

    expect(result.assistantContentBlocks).toEqual([
      { kind: 'assistant', id: 'preface', text: '我先检查一下。' }
    ])
    expect(result.processBlocks.map((block) => block.kind)).toEqual(['tool'])
  })

  it('does not create assistant content from tool-only process work', () => {
    const result = sections([
      {
        kind: 'tool',
        id: 'tool_1',
        summary: 'read',
        status: 'success',
        toolKind: 'tool_call'
      }
    ])

    expect(result.assistantContentBlocks).toEqual([])
    expect(result.processBlocks.map((block) => block.kind)).toEqual(['tool'])
  })

  it('extracts file changes from JSON-wrapped tool output diffs', () => {
    const patch = [
      'diff --git a/demo.ts b/demo.ts',
      '--- a/demo.ts',
      '+++ b/demo.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new'
    ].join('\n')
    const result = sections([
      {
        kind: 'tool',
        id: 'tool_1',
        summary: 'Edit',
        status: 'success',
        toolKind: 'file_change',
        filePath: '/tmp/demo.ts',
        detail: JSON.stringify({ path: '/tmp/demo.ts', diff: patch }, null, 2)
      }
    ])

    expect(result.turnFileChanges).toMatchObject([
      {
        id: 'tool_1',
        detail: patch,
        filePath: 'demo.ts'
      }
    ])
  })

  it('renders live assistant output inside the active process timeline', () => {
    const result = processingSections({
      liveProcessText: 'private reasoning',
      liveContent: '这里是正在生成的回答。'
    })

    expect(result.assistantContentBlocks).toEqual([])
    expect(result.processBlocks).toEqual([
      { kind: 'reasoning', id: 'live-reasoning', text: 'private reasoning' },
      { kind: 'assistant', id: 'live-assistant', text: '这里是正在生成的回答。' }
    ])
  })

  it('keeps assistant content in chronological process order while a later tool is still running', () => {
    const result = processingSections({
      blocks: [
        { kind: 'assistant', id: 'answer', text: '先给你一部分结果。' },
        {
          kind: 'tool',
          id: 'tool_1',
          summary: 'read',
          status: 'running',
          toolKind: 'tool_call'
        }
      ]
    })

    expect(result.assistantContentBlocks).toEqual([])
    expect(result.processBlocks).toEqual([
      { kind: 'assistant', id: 'answer', text: '先给你一部分结果。' },
      {
        kind: 'tool',
        id: 'tool_1',
        summary: 'read',
        status: 'running',
        toolKind: 'tool_call'
      }
    ])
  })

  it('places assistant output between process steps while processing', () => {
    const result = processingSections({
      blocks: [
        {
          kind: 'tool',
          id: 'tool_1',
          summary: 'read',
          status: 'success',
          toolKind: 'tool_call'
        },
        { kind: 'assistant', id: 'answer', text: '读完了，下一步继续查。' },
        {
          kind: 'tool',
          id: 'tool_2',
          summary: 'grep',
          status: 'running',
          toolKind: 'tool_call'
        }
      ]
    })

    expect(result.assistantContentBlocks).toEqual([])
    expect(result.processBlocks.map((block) => block.id)).toEqual(['tool_1', 'answer', 'tool_2'])
  })
})
