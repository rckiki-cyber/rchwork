import { describe, expect, it } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

describe('AssistantMarkdown streaming rendering', () => {
  it('has no plain-text bypass for live Markdown', () => {
    expect(typeof AssistantMarkdown).toBe('function')
    expect(AssistantMarkdown.toString()).not.toContain('shouldUseLightweightStreaming')
  })
})
