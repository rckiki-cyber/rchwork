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
  it('stays out when OfficeCLI is not explicitly available', () => {
    expect(officeDocumentWorkflowInstruction({
      prompt: '把综述整理成 Word 文档',
      items: [],
      turnId: 'turn-word',
      officeCliAvailable: false
    })).toBeUndefined()
  })

  it('describes Office MCP as a last-resort fallback after runtime unlock', () => {
    const instruction = officeDocumentWorkflowInstruction({
      prompt: '把综述整理成 Word 文档',
      items: [],
      turnId: 'turn-word',
      officeCliAvailable: true
    })

    expect(instruction).toContain('最后兜底临时解锁')
    expect(instruction).toContain('禁止 view html')
    expect(instruction).toContain('同类 set/add/remove 必须 batch')
    expect(instruction).toContain('最多做一次必要 validate')
  })

  it('adds compact feedback after granular edits, errors, and validation', () => {
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

    expect(instruction).toContain('已出现 4 次逐条修改')
    expect(instruction).toContain('已有 1 次 OfficeCLI 错误')
    expect(instruction).toContain('validate 后又修改 1 次')
  })
})
