import { describe, expect, it } from 'vitest'
import { isRuntimeProbePath } from './runtime-probe-path'

describe('isRuntimeProbePath', () => {
  it('recognizes transient read endpoints including the knowledge tree', () => {
    expect(isRuntimeProbePath('/v1/knowledge/tree?prefix=matter')).toBe(true)
    expect(isRuntimeProbePath('/v1/threads')).toBe(true)
    expect(isRuntimeProbePath('/data-compliance/tasks')).toBe(true)
  })

  it('does not suppress unrelated business endpoints', () => {
    expect(isRuntimeProbePath('/v1/knowledge/files')).toBe(false)
    expect(isRuntimeProbePath('/v1/turns')).toBe(false)
  })
})
