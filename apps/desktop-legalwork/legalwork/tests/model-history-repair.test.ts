import { describe, expect, it } from 'vitest'
import { repairModelHistoryItems } from '../src/domain/model-history-repair.js'
import { confirmedHistoryFingerprint, confirmedPrefixEquals, healLoadedHistoryItems } from '../src/loop/history-healing.js'
import {
  makeAssistantTextItem,
  makeToolCallItem,
  makeToolResultItem,
  makeUserItem
} from '../src/domain/item.js'

describe('model history repair', () => {
  it('keeps complete multi-tool blocks across assistant text bridges', () => {
    const orphanResult = makeToolResultItem({
      id: 'orphan_result',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_orphan',
      toolName: 'echo',
      output: 'orphan'
    })
    const missingCall = makeToolCallItem({
      id: 'missing_call',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_missing',
      toolName: 'echo',
      arguments: { text: 'missing' }
    })
    const callA = makeToolCallItem({
      id: 'call_a',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_a',
      toolName: 'echo',
      arguments: { text: 'a' }
    })
    const callB = makeToolCallItem({
      id: 'call_b',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_b',
      toolName: 'echo',
      arguments: { text: 'b' }
    })
    const bridgeText = makeAssistantTextItem({
      id: 'assistant_bridge',
      threadId: 'thr_1',
      turnId: 'turn_1',
      text: 'I will check both.',
      status: 'completed'
    })
    const resultA = makeToolResultItem({
      id: 'result_a',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_a',
      toolName: 'echo',
      output: 'a'
    })
    const resultB = makeToolResultItem({
      id: 'result_b',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_b',
      toolName: 'echo',
      output: 'b'
    })
    const duplicateResultB = makeToolResultItem({
      id: 'result_b_duplicate',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_b',
      toolName: 'echo',
      output: 'duplicate'
    })

    const repaired = repairModelHistoryItems([
      orphanResult,
      missingCall,
      makeUserItem({ id: 'user_1', threadId: 'thr_1', turnId: 'turn_1', text: 'continue' }),
      callA,
      callB,
      bridgeText,
      resultA,
      resultB,
      duplicateResultB
    ])

    expect(repaired.map((item) => item.id)).toEqual([
      'user_1',
      'call_a',
      'call_b',
      'assistant_bridge',
      'result_a',
      'result_b'
    ])
  })

  it('keeps assistant text when dropping an incomplete tool call', () => {
    const repaired = repairModelHistoryItems([
      makeToolCallItem({
        id: 'call_missing',
        threadId: 'thr_1',
        turnId: 'turn_1',
        callId: 'call_missing',
        toolName: 'echo',
        arguments: { text: 'missing' }
      }),
      makeAssistantTextItem({
        id: 'assistant_text',
        threadId: 'thr_1',
        turnId: 'turn_1',
        text: 'I will use echo.',
        status: 'completed'
      }),
      makeUserItem({ id: 'user_next', threadId: 'thr_1', turnId: 'turn_2', text: 'never mind' }),
      makeToolResultItem({
        id: 'late_result',
        threadId: 'thr_1',
        turnId: 'turn_1',
        callId: 'call_missing',
        toolName: 'echo',
        output: 'late'
      })
    ])

    expect(repaired.map((item) => item.id)).toEqual(['assistant_text', 'user_next'])
  })

  it('heals loaded history by adding missing ids and dropping invalid tool items', () => {
    const assistant = makeAssistantTextItem({
      id: 'assistant_missing_id',
      threadId: 'thr_1',
      turnId: 'turn_1',
      text: 'hello',
      status: 'completed'
    }) as Record<string, unknown>
    delete assistant.id
    const invalidCall = {
      ...makeToolCallItem({
        id: 'bad_call',
        threadId: 'thr_1',
        turnId: 'turn_1',
        callId: 'call_bad',
        toolName: 'echo',
        arguments: {}
      }),
      callId: ''
    }
    const invalidResult = {
      ...makeToolResultItem({
        id: 'bad_result',
        threadId: 'thr_1',
        turnId: 'turn_1',
        callId: 'call_bad',
        toolName: 'echo',
        output: 'orphan'
      }),
      toolName: ''
    }

    const healed = healLoadedHistoryItems([
      assistant as never,
      invalidCall as never,
      invalidResult as never
    ])

    expect(healed.changed).toBe(true)
    expect(healed.items).toHaveLength(1)
    expect(healed.items[0]).toMatchObject({
      kind: 'assistant_text',
      id: 'item_healed_0_assistant_text'
    })
  })
})

describe('confirmedHistoryFingerprint', () => {
  function historyWithTool(
    extra: Array<ReturnType<typeof makeToolResultItem>> = []
  ) {
    return [
      makeUserItem({ id: 'u1', threadId: 'thr', turnId: 't1', text: 'hello' }),
      makeAssistantTextItem({ id: 'a1', threadId: 'thr', turnId: 't1', text: 'checking' }),
      makeToolCallItem({
        id: 'c1',
        threadId: 'thr',
        turnId: 't1',
        callId: 'call1',
        toolName: 'bash',
        arguments: { command: 'ls' }
      }),
      makeToolResultItem({
        id: 'r1',
        threadId: 'thr',
        turnId: 't1',
        callId: 'call1',
        toolName: 'bash',
        output: 'file.txt'
      }),
      ...extra
    ]
  }

  it('is stable for the same confirmed history', () => {
    const a = confirmedHistoryFingerprint(historyWithTool())
    const b = confirmedHistoryFingerprint(historyWithTool())
    expect(a).toBe(b)
  })

  it('prefix equals stays true when a new tail accumulates after the confirmed segment', () => {
    // 缓存命中关键场景：step N 发送了 4 条确认历史，step N+1 多了新的
    // tool block。前 4 条（confirmed prefix）必须与上次完全一致。
    const base = historyWithTool()
    const grown = historyWithTool([
      makeToolCallItem({
        id: 'c2',
        threadId: 'thr',
        turnId: 't1',
        callId: 'call2',
        toolName: 'bash',
        arguments: { command: 'pwd' }
      }),
      makeToolResultItem({
        id: 'r2',
        threadId: 'thr',
        turnId: 't1',
        callId: 'call2',
        toolName: 'bash',
        output: '/tmp'
      })
    ])
    // 前 base.length 条与 base 一致（tail 不影响 prefix）
    expect(confirmedPrefixEquals(grown.slice(0, base.length), base)).toBe(true)
    // 完整对比（含 tail）会不同——所以必须按 prefix 比较
    expect(confirmedPrefixEquals(grown, base)).toBe(false)
  })

  it('changes when the confirmed content actually differs', () => {
    const changed = historyWithTool().map((item, index) =>
      index === 2
        ? makeToolCallItem({
            id: 'c1',
            threadId: 'thr',
            turnId: 't1',
            callId: 'call1',
            toolName: 'bash',
            arguments: { command: 'pwd' }
          })
        : item
    )
    expect(confirmedHistoryFingerprint(changed)).not.toBe(
      confirmedHistoryFingerprint(historyWithTool())
    )
  })
})
