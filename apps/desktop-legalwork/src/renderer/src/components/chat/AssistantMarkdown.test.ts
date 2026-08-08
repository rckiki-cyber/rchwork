import { describe, expect, it } from 'vitest'
import { shouldUseLightweightStreaming } from './AssistantMarkdown'

describe('AssistantMarkdown streaming degradation', () => {
  it('keeps short live answers in rich Markdown mode', () => {
    expect(shouldUseLightweightStreaming('# answer', true)).toBe(false)
  })

  it('uses lightweight text while a long answer is still streaming', () => {
    expect(shouldUseLightweightStreaming('长'.repeat(8_001), true)).toBe(true)
  })

  it('restores rich Markdown when the answer is complete', () => {
    expect(shouldUseLightweightStreaming('长'.repeat(20_000), false)).toBe(false)
  })
})
