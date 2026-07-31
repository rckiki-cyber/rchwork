import { describe, expect, it } from 'vitest'
import { buildTemplateLearningRequestBody } from './template-learning-service'

describe('template learning request', () => {
  it('disables DeepSeek thinking and requests JSON output', () => {
    const body = buildTemplateLearningRequestBody('deepseek-v4-flash', {
      fileName: '法律意见书.docx',
      fileContent: '法律意见书\n正文'
    })

    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.max_tokens).toBe(8192)
  })

  it('does not send DeepSeek-only parameters to other providers', () => {
    const body = buildTemplateLearningRequestBody('gpt-4.1', {
      fileName: '法律意见书.docx',
      fileContent: '法律意见书\n正文'
    })

    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('response_format')
  })
})
