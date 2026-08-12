import { describe, expect, it } from 'vitest'
import { isLearningIterationThreadTitle } from './internal-thread-mode.js'

describe('isLearningIterationThreadTitle', () => {
  it('recognizes runtime-created learning iteration threads', () => {
    expect(isLearningIterationThreadTitle('[Learning iteration] 2026-08-12-0002-1d0860f1')).toBe(true)
  })

  it('does not match ordinary threads', () => {
    expect(isLearningIterationThreadTitle('法律意见书')).toBe(false)
    expect(isLearningIterationThreadTitle('知识库：判决书.pdf')).toBe(false)
    expect(isLearningIterationThreadTitle(undefined)).toBe(false)
  })
})
