import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

describe('AssistantMarkdown fallback', () => {
  it('renders Markdown while the primary renderer chunk is still loading', () => {
    const html = renderToStaticMarkup(createElement(AssistantMarkdown, {
      text: '> 核心观点是**“噪声达标并不当然免责”**。',
      streaming: false
    }))

    expect(html).toContain('<blockquote>')
    expect(html).toContain('<strong>“噪声达标并不当然免责”</strong>')
    expect(html).not.toContain('**“噪声达标并不当然免责”**')
  })
})
