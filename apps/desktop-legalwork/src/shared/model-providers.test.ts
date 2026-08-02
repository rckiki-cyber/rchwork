import { describe, expect, it } from 'vitest'
import { inferEndpointFormatFromBaseUrl } from './model-providers'

describe('inferEndpointFormatFromBaseUrl', () => {
  it('maps Anthropic official endpoints to messages', () => {
    expect(inferEndpointFormatFromBaseUrl('https://api.anthropic.com/v1')).toBe('messages')
    expect(inferEndpointFormatFromBaseUrl('https://api.anthropic.com')).toBe('messages')
  })

  it('maps the claude provider id to messages regardless of URL', () => {
    expect(inferEndpointFormatFromBaseUrl('https://any-gateway.example.com', 'claude')).toBe('messages')
  })

  it('maps OpenAI official to chat_completions (most compatible default)', () => {
    expect(inferEndpointFormatFromBaseUrl('https://api.openai.com/v1')).toBe('chat_completions')
  })

  it('maps CN providers to chat_completions', () => {
    expect(inferEndpointFormatFromBaseUrl('https://api.deepseek.com')).toBe('chat_completions')
    expect(inferEndpointFormatFromBaseUrl('https://api.moonshot.cn/v1')).toBe('chat_completions')
    expect(inferEndpointFormatFromBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('chat_completions')
  })

  it('maps custom/relay endpoints to chat_completions', () => {
    expect(inferEndpointFormatFromBaseUrl('https://oneapi.example.com/v1')).toBe('chat_completions')
    expect(inferEndpointFormatFromBaseUrl('https://api.example.com/v1')).toBe('chat_completions')
  })

  it('defaults empty or missing URLs to chat_completions', () => {
    expect(inferEndpointFormatFromBaseUrl('')).toBe('chat_completions')
    expect(inferEndpointFormatFromBaseUrl(undefined)).toBe('chat_completions')
  })
})
