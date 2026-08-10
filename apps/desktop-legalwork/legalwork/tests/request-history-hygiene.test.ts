import { describe, expect, it } from 'vitest'
import {
  applyRequestHistoryHygiene,
  contextAwareRequestHistoryHygieneOptions
} from '../src/loop/request-history-hygiene.js'
import { makeToolCallItem, makeToolResultItem } from '../src/domain/item.js'

describe('request history hygiene', () => {
  it('scales legacy tool-result limits for a 1M context model', () => {
    expect(contextAwareRequestHistoryHygieneOptions({
      maxToolResultLines: 320,
      maxToolResultBytes: 32 * 1024,
      maxToolResultTokens: 8_000
    }, 1_000_000)).toMatchObject({
      maxToolResultLines: 6_000,
      maxToolResultBytes: 512 * 1024,
      maxToolResultTokens: 128_000
    })
  })

  it('shrinks oversized tool results while preserving head, signal lines, and tail', () => {
    const longOutput = Array.from({ length: 500 }, (_, index) => {
      if (index === 240) return 'ERROR failed to compile auth middleware'
      return `plain output line ${index}`
    }).join('\n')
    const result = makeToolResultItem({
      id: 'result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_bash',
      toolName: 'bash',
      output: { output: longOutput }
    })

    const compacted = applyRequestHistoryHygiene([result], {
      maxToolResultLines: 80,
      maxToolResultBytes: 4 * 1024
    })
    const compactedResult = compacted[0]
    const originalText = result.kind === 'tool_result' ? JSON.stringify(result.output) : ''
    const compactedText = compactedResult?.kind === 'tool_result'
      ? JSON.stringify(compactedResult.output)
      : ''

    expect(compactedResult).not.toBe(result)
    expect(originalText).toContain('plain output line 499')
    expect(compactedText.length).toBeLessThan(originalText.length)
    expect(compactedText).toContain('plain output line 0')
    expect(compactedText).toContain('ERROR failed to compile auth middleware')
    expect(compactedText).toContain('plain output line 499')
    expect(compactedText).toContain('cache hygiene')
  })

  it('omits long completed tool-call argument strings only when the result is paired', () => {
    const pairedCall = makeToolCallItem({
      id: 'call_item',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_write',
      toolName: 'write',
      arguments: {
        path: 'src/generated.ts',
        content: 'x'.repeat(12_000)
      }
    })
    const result = makeToolResultItem({
      id: 'result_item',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_write',
      toolName: 'write',
      output: 'wrote src/generated.ts'
    })
    const unpairedCall = makeToolCallItem({
      id: 'unpaired_call_item',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_pending',
      toolName: 'write',
      arguments: { content: 'y'.repeat(12_000) }
    })

    const compacted = applyRequestHistoryHygiene([pairedCall, result, unpairedCall])
    const nextPairedCall = compacted[0]
    const nextUnpairedCall = compacted[2]

    expect(nextPairedCall?.kind === 'tool_call' ? String(nextPairedCall.arguments.content) : '')
      .toContain('cache hygiene')
    expect(nextPairedCall?.kind === 'tool_call' ? nextPairedCall.arguments.path : '')
      .toBe('src/generated.ts')
    expect(nextUnpairedCall?.kind === 'tool_call' ? String(nextUnpairedCall.arguments.content).length : 0)
      .toBe(12_000)
  })

  it('makes compressed historical document content impossible to mistake for the executed input', () => {
    const call = makeToolCallItem({
      id: 'document_call',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_document',
      toolName: 'document_skill_execute',
      arguments: {
        kind: 'docx',
        operation: 'from-markdown',
        content: '# 文献综述\n\n'.concat('完整正文。'.repeat(3_000)),
        outputPath: '综述.docx'
      }
    })
    const result = makeToolResultItem({
      id: 'document_result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_document',
      toolName: 'document_skill_execute',
      output: { status: 'ok', output: '综述.docx' }
    })

    const compacted = applyRequestHistoryHygiene([call, result])
    const content = compacted[0]?.kind === 'tool_call'
      ? String(compacted[0].arguments.content)
      : ''

    expect(content).toContain('HISTORY VIEW ONLY')
    expect(content).toContain('original COMPLETE document content was sent to the tool')
    expect(content).toContain('was NOT the executed argument')
    expect(content).toContain('do NOT regenerate')
    expect(content).not.toContain('preview=')
  })

  it('shrinks dense text when the approximate token cap is exceeded before the byte cap', () => {
    const denseOutput = '汉'.repeat(9_000)
    const result = makeToolResultItem({
      id: 'dense_result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_read',
      toolName: 'read',
      output: { content: denseOutput }
    })

    const compacted = applyRequestHistoryHygiene([result], {
      maxToolResultBytes: 32 * 1024,
      maxToolResultTokens: 4_000
    })
    const compactedResult = compacted[0]
    const compactedText = compactedResult?.kind === 'tool_result'
      ? String((compactedResult.output as { content?: string }).content ?? '')
      : ''

    expect(Buffer.byteLength(denseOutput, 'utf8')).toBeLessThan(32 * 1024)
    expect(compactedText.length).toBeLessThan(denseOutput.length)
    expect(compactedText).toContain('approx')
    expect(compactedText).toContain('cache hygiene')
  })

  it('shrinks completed tool-call args when only the approximate token cap is exceeded', () => {
    const pairedCall = makeToolCallItem({
      id: 'dense_call',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_write',
      toolName: 'write',
      arguments: {
        path: 'src/generated.txt',
        content: '汉'.repeat(2_500)
      }
    })
    const result = makeToolResultItem({
      id: 'dense_result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_write',
      toolName: 'write',
      output: 'wrote src/generated.txt'
    })

    const compacted = applyRequestHistoryHygiene([pairedCall, result], {
      maxToolArgumentStringBytes: 8 * 1024,
      maxToolArgumentStringTokens: 2_000
    })
    const nextCall = compacted[0]

    expect(nextCall?.kind === 'tool_call' ? String(nextCall.arguments.content) : '')
      .toContain('approx')
    expect(nextCall?.kind === 'tool_call' ? String(nextCall.arguments.content) : '')
      .toContain('cache hygiene')
  })

  it('replaces base64 payloads in model-bound history', () => {
    const result = makeToolResultItem({
      id: 'image_result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_read',
      toolName: 'read',
      output: { data_base64: 'a'.repeat(2_000), mime: 'image/png' }
    })

    const compacted = applyRequestHistoryHygiene([result])
    const compactedResult = compacted[0]

    expect(compactedResult?.kind === 'tool_result' ? compactedResult.output : {}).toMatchObject({
      data_base64: expect.stringContaining('omitted base64 data'),
      mime: 'image/png'
    })
  })

  it('caps aggregate structured results even when every nested string is individually small', () => {
    const output = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [
        `result_${index}`,
        { title: `文献 ${index}`, abstract: '摘'.repeat(300), source: `source-${index}` }
      ])
    )
    const result = makeToolResultItem({
      id: 'structured_result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_mcp',
      toolName: 'mcp_call',
      output
    })

    const compacted = applyRequestHistoryHygiene([result], {
      maxToolResultBytes: 4 * 1024,
      maxToolResultTokens: 2_000
    })
    const compactedOutput = compacted[0]?.kind === 'tool_result'
      ? compacted[0].output
      : undefined
    const serialized = JSON.stringify(compactedOutput)

    expect(typeof compactedOutput).toBe('string')
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(5 * 1024)
    expect(serialized).toContain('cache hygiene')
  })
})
