import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AstryxSegmentButton } from './AstryxSegmentButton'

describe('AstryxSegmentButton', () => {
  it('uses an accent fill and readable text for the selected state', () => {
    const html = renderToStaticMarkup(
      createElement(
        AstryxSegmentButton,
        { selected: true, onClick: vi.fn(), children: 'Medium' }
      )
    )

    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('data-state="selected"')
    expect(html).toContain('border-accent bg-accent text-white')
    expect(html).toContain('Medium')
  })

  it('uses the neutral surface for the unselected state', () => {
    const html = renderToStaticMarkup(
      createElement(
        AstryxSegmentButton,
        { selected: false, onClick: vi.fn(), children: 'Low' }
      )
    )

    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('data-state="unselected"')
    expect(html).toContain('border-ds-border bg-ds-main/55 text-ds-muted')
  })
})
