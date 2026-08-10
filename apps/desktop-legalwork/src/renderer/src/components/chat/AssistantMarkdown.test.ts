import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AssistantMarkdown,
  nextStreamingRevealLength,
  shouldUseLightweightStreaming
} from './AssistantMarkdown'

describe('AssistantMarkdown streaming degradation', () => {
  it('keeps every non-empty live answer in lightweight streaming mode', () => {
    expect(shouldUseLightweightStreaming('# answer', true)).toBe(true)
  })

  it('does not create a streaming surface before text arrives', () => {
    expect(shouldUseLightweightStreaming('', true)).toBe(false)
  })

  it('restores rich Markdown when the answer is complete', () => {
    expect(shouldUseLightweightStreaming('长'.repeat(20_000), false)).toBe(false)
  })

  it('renders live text through the smooth streaming surface', () => {
    const html = renderToStaticMarkup(
      createElement(AssistantMarkdown, { text: '正在输出', streaming: true })
    )
    expect(html).toContain('data-smooth-streaming="true"')
    expect(html).toContain('正在输出')
  })

  it('reveals small deltas on the next frame', () => {
    expect(nextStreamingRevealLength(10, '字'.repeat(11))).toBe(11)
  })

  it('catches up a large provider burst over a few frames', () => {
    expect(nextStreamingRevealLength(100, '字'.repeat(200))).toBe(125)
  })

  it('does not split a surrogate pair at the reveal boundary', () => {
    expect(nextStreamingRevealLength(0, '😀abc')).toBe(2)
  })
})
