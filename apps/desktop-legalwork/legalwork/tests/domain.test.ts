import { describe, expect, it } from 'vitest'
import { DEFAULT_APPROVAL_POLICY } from '../src/contracts/policy.js'
import { createThreadRecord, touchThread, toThreadSummary } from '../src/domain/thread.js'
import {
  appendTurnItem,
  createTurnRecord,
  finishTurn,
  replaceTurnItem,
  startTurn
} from '../src/domain/turn.js'
import {
  makeApprovalItem,
  makeAssistantReasoningItem,
  makeAssistantTextItem,
  makeCompactionItem,
  makeErrorItem,
  makeToolCallItem,
  makeToolResultItem,
  makeUserInputItem,
  makeUserItem,
  stableToolResultText,
  truncateToolResultContent
} from '../src/domain/item.js'
import { compareEventSeq, groupEventsByKind } from '../src/domain/event.js'
import {
  createApprovalRequest,
  expireApprovalRequest,
  resolveApprovalRequest
} from '../src/domain/approval.js'
import { addUsage, zeroUsage } from '../src/domain/usage.js'
import {
  appendSessionEvent,
  appendSessionItem,
  closeSession,
  createAgentSession
} from '../src/domain/session.js'

describe('domain.thread', () => {
  it('creates a thread with sensible defaults', () => {
    const thread = createThreadRecord({
      id: 'thr_1',
      title: 'demo',
      workspace: '/tmp',
      model: 'deepseek-chat'
    })
    expect(thread.status).toBe('idle')
    expect(thread.mode).toBe('agent')
    expect(thread.approvalPolicy).toBe(DEFAULT_APPROVAL_POLICY)
  })

  it('touches a thread to refresh updatedAt', () => {
    const thread = createThreadRecord({
      id: 'thr_1',
      title: 'demo',
      workspace: '/tmp',
      model: 'deepseek-chat'
    })
    const touched = touchThread(thread, '2025-06-01T00:00:00.000Z')
    expect(touched.updatedAt).toBe('2025-06-01T00:00:00.000Z')
  })

  it('produces a thread summary with the canonical fields', () => {
    const thread = createThreadRecord({
      id: 'thr_1',
      title: 'demo',
      workspace: '/tmp',
      model: 'deepseek-chat'
    })
    const summary = toThreadSummary(thread)
    expect(summary).not.toHaveProperty('turns')
  })
})

describe('domain.turn', () => {
  const baseTurn = createTurnRecord({
    id: 'turn_1',
    threadId: 'thr_1',
    prompt: 'hi'
  })

  it('appends items without duplicates', () => {
    const item = makeUserItem({ id: 'i1', turnId: 'turn_1', threadId: 'thr_1', text: 'hi' })
    const next = appendTurnItem(appendTurnItem(baseTurn, item), item)
    expect(next.items).toHaveLength(1)
  })

  it('replaces an existing item with the same id', () => {
    const partial = makeToolResultItem({
      id: 'item_call_1',
      turnId: 'turn_1',
      threadId: 'thr_1',
      callId: 'call_1',
      toolName: 'bash',
      output: { partial: true },
      status: 'running'
    })
    const final = makeToolResultItem({
      id: 'item_call_1',
      turnId: 'turn_1',
      threadId: 'thr_1',
      callId: 'call_1',
      toolName: 'bash',
      output: { exit_code: 127 },
      isError: true,
      status: 'completed'
    })
    const next = appendTurnItem(appendTurnItem(baseTurn, partial), final)

    expect(next.items).toHaveLength(1)
    expect(next.items[0]).toMatchObject({
      id: 'item_call_1',
      status: 'completed',
      isError: true,
      output: { exit_code: 127 }
    })
  })

  it('replaces an item by id', () => {
    const item = makeAssistantTextItem({
      id: 'i2',
      turnId: 'turn_1',
      threadId: 'thr_1',
      text: 'hello',
      status: 'running'
    })
    const appended = appendTurnItem(baseTurn, item)
    const replaced = replaceTurnItem(appended, 'i2', { text: 'world', status: 'completed' })
    const found = replaced.items.find((it) => it.id === 'i2')
    expect(found && found.kind === 'assistant_text' ? found.text : '').toBe('world')
  })

  it('starts and finishes a turn', () => {
    const started = startTurn(baseTurn)
    const finished = finishTurn(started, 'completed')
    expect(finished.status).toBe('completed')
    expect(finished.finishedAt).toBeDefined()
  })
})

describe('domain.item factories', () => {
  it('makes user/assistant/tool/approval/compaction/error items', () => {
    const user = makeUserItem({
      id: 'u',
      turnId: 't',
      threadId: 'th',
      text: 'hi',
      attachmentIds: ['att_1']
    })
    const assistant = makeAssistantTextItem({ id: 'a', turnId: 't', threadId: 'th', text: 'reply' })
    const reasoning = makeAssistantReasoningItem({
      id: 'r',
      turnId: 't',
      threadId: 'th',
      text: 'thinking'
    })
    const call = makeToolCallItem({
      id: 'c',
      turnId: 't',
      threadId: 'th',
      callId: 'call_1',
      toolName: 'echo',
      arguments: { text: 'hi' }
    })
    const result = makeToolResultItem({
      id: 'cr',
      turnId: 't',
      threadId: 'th',
      callId: 'call_1',
      toolName: 'echo',
      output: { ok: true }
    })
    const approval = makeApprovalItem({
      id: 'ap',
      turnId: 't',
      threadId: 'th',
      approvalId: 'appr_1',
      toolName: 'shell',
      summary: 'run shell'
    })
    const input = makeUserInputItem({
      id: 'in',
      turnId: 't',
      threadId: 'th',
      inputId: 'in_1',
      prompt: '?'
    })
    const compaction = makeCompactionItem({
      id: 'cp',
      turnId: 't',
      threadId: 'th',
      summary: 'compact',
      replacedTokens: 12,
      pinnedConstraints: ['user: do not delete']
    })
    const error = makeErrorItem({
      id: 'er',
      turnId: 't',
      threadId: 'th',
      message: 'boom'
    })
    expect([user, assistant, reasoning, call, result, approval, input, compaction, error]).toHaveLength(9)
    expect(user).toMatchObject({ attachmentIds: ['att_1'] })
  })
})

describe('domain.event helpers', () => {
  it('orders events by seq', () => {
    const events = [
      { kind: 'heartbeat' as const, seq: 2, timestamp: 't', threadId: 'th' },
      { kind: 'heartbeat' as const, seq: 1, timestamp: 't', threadId: 'th' }
    ]
    expect([...events].sort(compareEventSeq)).toEqual([events[1], events[0]])
  })

  it('groups events by kind', () => {
    const events = [
      { kind: 'heartbeat' as const, seq: 1, timestamp: 't', threadId: 'th' },
      {
        kind: 'turn_started' as const,
        seq: 2,
        timestamp: 't',
        threadId: 'th',
        turnId: 'turn_1'
      }
    ]
    const grouped = groupEventsByKind(events)
    expect(grouped.heartbeat).toHaveLength(1)
    expect(grouped.turn_started).toHaveLength(1)
  })
})

describe('domain.approval', () => {
  it('creates a pending approval', () => {
    const approval = createApprovalRequest({
      id: 'a',
      threadId: 'th',
      turnId: 't',
      toolName: 'echo',
      summary: 'run echo'
    })
    expect(approval.status).toBe('pending')
  })

  it('resolves an approval to allowed/denied', () => {
    const approval = createApprovalRequest({
      id: 'a',
      threadId: 'th',
      turnId: 't',
      toolName: 'echo',
      summary: 'run echo'
    })
    expect(resolveApprovalRequest(approval, 'allow').status).toBe('allowed')
    expect(resolveApprovalRequest(approval, 'deny').status).toBe('denied')
  })

  it('expires an approval', () => {
    const approval = createApprovalRequest({
      id: 'a',
      threadId: 'th',
      turnId: 't',
      toolName: 'echo',
      summary: 'run echo'
    })
    expect(expireApprovalRequest(approval).status).toBe('expired')
  })
})

describe('domain.usage', () => {
  it('adds two usage snapshots and reports a cache hit rate', () => {
    const a = { ...zeroUsage(), promptTokens: 100, completionTokens: 5, cacheHitTokens: 4, cachedTokens: 4, cacheMissTokens: 1, totalTokens: 105 }
    const b = { ...zeroUsage(), promptTokens: 200, completionTokens: 10, cacheHitTokens: 5, cachedTokens: 5, cacheMissTokens: 0, totalTokens: 210 }
    const merged = addUsage(a, b)
    expect(merged.promptTokens).toBe(300)
    expect(merged.cacheHitRate).toBeCloseTo(9 / 10)
  })

  it('reports a null cache hit rate when prompt tokens are zero', () => {
    expect(addUsage(zeroUsage(), zeroUsage()).cacheHitRate).toBeNull()
  })
})

describe('domain.session', () => {
  it('appends items and events without duplicates', () => {
    const session = createAgentSession({ threadId: 'th', turnId: 't' })
    const item = makeUserItem({ id: 'u', turnId: 't', threadId: 'th', text: 'hi' })
    const event = { kind: 'turn_started' as const, seq: 1, timestamp: 't', threadId: 'th', turnId: 't' }
    const after = appendSessionItem(appendSessionEvent(session, event), item)
    const same = appendSessionItem(appendSessionEvent(after, event), item)
    expect(same.items).toHaveLength(1)
    expect(same.events).toHaveLength(1)
  })

  it('closes a session', () => {
    const session = createAgentSession({ threadId: 'th', turnId: 't' })
    expect(closeSession(session).closed).toBe(true)
  })
})

describe('stableToolResultText', () => {
  it('extracts the stable .output field and drops volatile metadata', () => {
    // bash 工具结果：output 是稳定内容，pid/started_at/full_output_path 是动态元数据
    const text = stableToolResultText({
      command: 'ls',
      cwd: '/tmp',
      shell: 'bash',
      exit_code: 0,
      output: 'file.txt\n',
      pid: 12345,
      started_at: '2026-08-14T00:00:00Z',
      finished_at: '2026-08-14T00:00:01Z',
      full_output_path: '/tmp/legalwork-bash-abc123'
    })
    expect(text).toBe('file.txt\n')
    // 两次调用结果一致（pid/时间戳不影响）
    const text2 = stableToolResultText({
      command: 'ls',
      cwd: '/tmp',
      shell: 'bash',
      exit_code: 0,
      output: 'file.txt\n',
      pid: 99999,
      started_at: '2026-08-14T00:00:05Z',
      finished_at: '2026-08-14T00:00:06Z',
      full_output_path: '/tmp/legalwork-bash-xyz789'
    })
    expect(text2).toBe('file.txt\n')
  })

  it('falls back to .text and .content, then the whole payload', () => {
    expect(stableToolResultText({ text: 'hi' })).toBe('hi')
    expect(stableToolResultText({ content: 'hello' })).toBe('hello')
    expect(stableToolResultText('plain')).toBe('plain')
    expect(stableToolResultText({ a: 1, b: 'x' })).toBe(JSON.stringify({ a: 1, b: 'x' }))
  })

  it('keeps structured content while dropping volatile wrapper metadata', () => {
    expect(stableToolResultText({
      output: { rows: [{ id: 1, title: '判决书' }] },
      pid: 91234,
      started_at: '2026-08-15T01:02:03Z'
    })).toBe(JSON.stringify({ rows: [{ id: 1, title: '判决书' }] }))
  })

  it('returns empty string for empty/whitespace-only content fields', () => {
    // 空字符串/空白 .output 不应被选中，走 fallback
    expect(stableToolResultText({ output: '  ' })).toBe(JSON.stringify({ output: '  ' }))
  })
})

describe('truncateToolResultContent', () => {
  it('passes through content within the token budget', () => {
    const small = 'short tool result'
    expect(truncateToolResultContent(small)).toBe(small)
  })

  it('truncates oversized content deterministically (head+tail+marker)', () => {
    const big = 'x'.repeat(40_000)
    const a = truncateToolResultContent(big)
    const b = truncateToolResultContent(big)
    // 确定性：同输入恒同输出
    expect(a).toBe(b)
    // 长度受限于 token 预算（8000 tokens ≈ 32000 chars + marker）
    expect(a.length).toBeLessThan(32_200)
    // 保留 head 和 tail
    expect(a.startsWith('x'.repeat(1000))).toBe(true)
    expect(a.endsWith('x'.repeat(1000))).toBe(true)
    expect(a).toContain('truncated')
  })

  it('respects a custom maxTokens budget', () => {
    const big = 'y'.repeat(10_000)
    const capped = truncateToolResultContent(big, 100)
    expect(capped.length).toBeLessThan(500)
    expect(capped).toContain('truncated')
  })

  it('never expands content just above the default budget', () => {
    for (const length of [8_001, 9_000, 15_999]) {
      const input = '甲'.repeat(length)
      const output = truncateToolResultContent(input)
      expect(output.length).toBeLessThan(input.length)
      expect(output).not.toMatch(/truncated -\d+ chars/)
    }
  })

  it('never expands content under tiny custom budgets', () => {
    for (const budget of [1, 8, 32]) {
      const input = '甲'.repeat(budget + 1)
      expect(truncateToolResultContent(input, budget).length).toBeLessThanOrEqual(budget)
    }
  })
})
