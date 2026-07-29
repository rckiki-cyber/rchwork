import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  isExternalMarkdownHref,
  shouldAnimateStreamingText,
  StreamdownAssistant
} from './StreamdownAssistant'

describe('shouldAnimateStreamingText', () => {
  it('keeps the lightweight reveal for short single-line text', () => {
    expect(shouldAnimateStreamingText('正在检查配置。')).toBe(true)
    expect(shouldAnimateStreamingText('Checking the CSS variables.')).toBe(true)
  })

  it('lets multiline streaming render from the actual SSE sequence', () => {
    expect(shouldAnimateStreamingText('First line\nSecond line')).toBe(false)
    expect(shouldAnimateStreamingText('First paragraph\n\nSecond paragraph')).toBe(false)
  })

  it('does not animate structured markdown while it is still streaming', () => {
    expect(shouldAnimateStreamingText('- one\n- two')).toBe(false)
    expect(shouldAnimateStreamingText('Use `npm test` next.')).toBe(false)
  })

  it('recognizes only browser-safe Markdown links as external targets', () => {
    expect(isExternalMarkdownHref('https://www.pkulaw.com/')).toBe(true)
    expect(isExternalMarkdownHref('http://example.com/law')).toBe(true)
    expect(isExternalMarkdownHref('mailto:research@example.com')).toBe(true)
    expect(isExternalMarkdownHref('javascript:alert(1)')).toBe(false)
    expect(isExternalMarkdownHref('file:///tmp/report.md')).toBe(false)
    expect(isExternalMarkdownHref('not a url')).toBe(false)
  })

  it('renders a verified legal-source Markdown link as a clickable external anchor', () => {
    const html = renderToStaticMarkup(
      createElement(StreamdownAssistant, {
        text: '[《个人信息保护法》](https://www.pkulaw.com/law/example)',
        streaming: false
      })
    )

    expect(html).toContain('href="https://www.pkulaw.com/law/example"')
    expect(html).toContain('class="ds-external-link"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('《个人信息保护法》')
  })
})
