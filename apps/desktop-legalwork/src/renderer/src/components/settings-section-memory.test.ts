import { describe, expect, it } from 'vitest'
import type { CoreMemoryRecordJson } from '../agent/legalwork-contract'
import { filterMemoryRecords, memoryTab } from './settings-section-memory'

const base: CoreMemoryRecordJson = {
  id: 'mem_1',
  content: '用户偏好简洁的合同审查意见',
  scope: 'workspace',
  category: 'preference',
  recallPolicy: 'always',
  captureSource: 'automatic',
  tags: ['合同'],
  confidence: 0.9,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

describe('memory settings filters', () => {
  it('classifies active, disabled, and deleted records', () => {
    expect(memoryTab(base)).toBe('active')
    expect(memoryTab({ ...base, disabledAt: 't1' })).toBe('disabled')
    expect(memoryTab({ ...base, disabledAt: 't1', deletedAt: 't2' })).toBe('deleted')
  })

  it('filters full text, tags, scope, category, and state', () => {
    const records: CoreMemoryRecordJson[] = [
      base,
      {
        ...base,
        id: 'mem_2',
        content: 'Use pnpm',
        scope: 'user',
        category: 'workflow',
        tags: ['frontend']
      },
      { ...base, id: 'mem_3', deletedAt: 't2' }
    ]

    expect(filterMemoryRecords(records, {
      tab: 'active',
      query: '合同',
      scope: 'workspace',
      category: 'preference'
    }).map((record) => record.id)).toEqual(['mem_1'])
    expect(filterMemoryRecords(records, {
      tab: 'active',
      query: 'FRONTEND',
      scope: 'user',
      category: 'workflow'
    }).map((record) => record.id)).toEqual(['mem_2'])
    expect(filterMemoryRecords(records, {
      tab: 'deleted',
      query: '',
      scope: 'all',
      category: 'all'
    }).map((record) => record.id)).toEqual(['mem_3'])
  })
})
