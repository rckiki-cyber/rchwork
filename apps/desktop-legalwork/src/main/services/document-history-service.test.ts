import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DocumentHistoryRecord } from '../../shared/document-history'
import {
  getHistoryRecord,
  listHistory,
  saveHistoryRecord,
  setHistoryBaseDir
} from './document-history-service'

describe('document history persistence', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'legalwork-document-history-'))
    setHistoryBaseDir(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('serializes concurrent saves instead of losing records', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      saveHistoryRecord(record(`record-${index}`))
    )))

    expect(results.every((result) => result.ok)).toBe(true)
    expect(await listHistory()).toHaveLength(20)
  })

  it('does not expose mutable references to the in-memory history cache', async () => {
    await saveHistoryRecord(record('immutable'))
    const loaded = await getHistoryRecord('immutable')
    expect(loaded).not.toBeNull()
    loaded!.generatedContent = '被调用方篡改'

    expect((await getHistoryRecord('immutable'))?.generatedContent).toBe('生成正文')
  })

  function record(id: string): DocumentHistoryRecord {
    return {
      id,
      templateName: '法律意见书',
      templateCategory: '法律文书',
      templateSource: 'builtin',
      fieldValues: {},
      materialFileNames: [],
      instructions: '',
      generatedContent: '生成正文',
      createdAt: '2026-08-08T00:00:00.000Z'
    }
  }
})
