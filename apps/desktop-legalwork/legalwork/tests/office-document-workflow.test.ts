import { describe, expect, it } from 'vitest'
import type { TurnItem } from '../src/contracts/items.js'
import {
  OFFICECLI_TOOL_NAME,
  officeDocumentWorkflowInstruction
} from '../src/loop/office-document-workflow.js'

const now = '2026-08-01T00:00:00.000Z'

function toolCall(callId: string, command: unknown): TurnItem {
  return {
    id: `item-${callId}`,
    turnId: 'turn-word',
    threadId: 'thread-word',
    role: 'assistant',
    status: 'completed',
    createdAt: now,
    finishedAt: now,
    kind: 'tool_call',
    toolName: OFFICECLI_TOOL_NAME,
    callId,
    toolKind: 'tool_call',
    arguments: { command }
  }
}

function toolResult(callId: string, isError = false): TurnItem {
  return {
    id: `result-${callId}`,
    turnId: 'turn-word',
    threadId: 'thread-word',
    role: 'tool',
    status: isError ? 'failed' : 'completed',
    createdAt: now,
    finishedAt: now,
    kind: 'tool_result',
    toolName: OFFICECLI_TOOL_NAME,
    callId,
    toolKind: 'tool_call',
    output: isError ? { error: 'bad command' } : { ok: true },
    isError
  }
}

describe('officeDocumentWorkflowInstruction', () => {
  it('stays out of unrelated turns', () => {
    expect(officeDocumentWorkflowInstruction({
      prompt: '解释一下行政处罚法',
      items: [],
      turnId: 'turn-word',
      officeCliAvailable: true
    })).toBeUndefined()
  })

  it('activates for Word output without imposing a hard speed limit', () => {
    const instruction = officeDocumentWorkflowInstruction({
      prompt: '把综述整理成 Word 文档',
      items: [],
      turnId: 'turn-word',
      officeCliAvailable: true
    })

    expect(instruction).toContain('质量优先')
    expect(instruction).toContain('优先使用 OfficeCLI batch')
    expect(instruction).toContain('若仍存在实质问题则继续')
    expect(instruction).not.toContain('最多调用')
  })

  it('adds targeted feedback after granular edits, errors, and validation', () => {
    const items = [
      toolCall('add-1', ['add', '/tmp/report.docx', '/body']),
      toolResult('add-1'),
      toolCall('add-2', ['add', '/tmp/report.docx', '/body']),
      toolResult('add-2'),
      toolCall('add-3', ['add', '/tmp/report.docx', '/body']),
      toolResult('add-3', true),
      toolCall('validate-1', ['validate', '/tmp/report.docx']),
      toolResult('validate-1'),
      toolCall('set-1', ['set', '/tmp/report.docx', '/body/p[1]']),
      toolResult('set-1')
    ]
    const instruction = officeDocumentWorkflowInstruction({
      prompt: '',
      items,
      turnId: 'turn-word',
      officeCliAvailable: true
    })

    expect(instruction).toContain('本轮已出现 4 次逐条文档修改')
    expect(instruction).toContain('本轮已有 1 次 OfficeCLI 错误')
    expect(instruction).toContain('文档已验证通过，之后又执行了 1 次修改')
    expect(instruction).toContain('不要编造“工具调用 N”清单')
  })
})
