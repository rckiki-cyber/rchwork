import { describe, expect, it } from 'vitest'
import { completionContent } from './document-generation-service'

describe('document generation response parsing', () => {
  it('accepts ordinary string content and multipart OpenAI-compatible content', () => {
    expect(completionContent({
      choices: [{ message: { content: '  完整法律文书  ' } }]
    })).toBe('完整法律文书')

    expect(completionContent({
      choices: [{ message: { content: [
        { type: 'text', text: '第一部分' },
        { type: 'text', text: '第二部分' }
      ] } }]
    })).toBe('第一部分第二部分')
  })

  it('rejects malformed completion envelopes instead of returning non-text values', () => {
    expect(completionContent({ choices: [{ message: { content: { text: '错误形状' } } }] })).toBe('')
    expect(completionContent({ error: 'upstream failure' })).toBe('')
  })
})
