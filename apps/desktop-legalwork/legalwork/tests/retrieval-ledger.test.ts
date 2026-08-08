import { describe, expect, it } from 'vitest'
import { RetrievalLedger } from '../src/loop/agent-loop.js'

describe('RetrievalLedger', () => {
  it('reserves an in-flight call so parallel duplicates are suppressed', () => {
    const ledger = new RetrievalLedger()
    const args = { path: '论文/行政法.pdf', offset: 1, limit: 120 }

    expect(ledger.reserve('knowledge_read_file', args)).toBeNull()
    expect(ledger.reserve('knowledge_read_file', { ...args, limit: 200 }))
      .toBe('knowledge_read_file:论文/行政法.pdf@1')

    ledger.finish('knowledge_read_file', args, true)
    expect(ledger.reserve('knowledge_read_file', args))
      .toBe('knowledge_read_file:论文/行政法.pdf@1')
  })

  it('allows retry after failure and invalidates live reads after a mutation', () => {
    const ledger = new RetrievalLedger()
    const args = { prefix: '论文' }

    expect(ledger.reserve('knowledge_list_tree', args)).toBeNull()
    ledger.finish('knowledge_list_tree', args, false)
    expect(ledger.reserve('knowledge_list_tree', args)).toBeNull()
    ledger.finish('knowledge_list_tree', args, true)
    expect(ledger.reserve('knowledge_list_tree', args)).not.toBeNull()

    ledger.clear()
    expect(ledger.reserve('knowledge_list_tree', args)).toBeNull()
  })
})
