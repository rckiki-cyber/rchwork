import { describe, expect, it } from 'vitest'
import { normalizeDeepseekServerSearchBaseUrl } from './deepseek-server-search-provider.js'

describe('normalizeDeepseekServerSearchBaseUrl', () => {
  it('accepts both OpenAI-style /v1 URLs and API root URLs', () => {
    expect(normalizeDeepseekServerSearchBaseUrl('https://api.deepseek.com/v1'))
      .toBe('https://api.deepseek.com')
    expect(normalizeDeepseekServerSearchBaseUrl('https://api.deepseek.com/'))
      .toBe('https://api.deepseek.com')
  })
})
