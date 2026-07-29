import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AstryxToggle } from './AstryxToggle'

describe('AstryxToggle', () => {
  it('renders a distinct accent checked state with a check marker', () => {
    const html = renderToStaticMarkup(
      createElement(AstryxToggle, { checked: true, onChange: vi.fn() })
    )

    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('data-state="checked"')
    expect(html).toContain('border-accent bg-accent')
    expect(html).toContain('translate-x-5')
    expect(html).toContain('lucide-check')
  })

  it('renders a neutral unchecked state with a minus marker', () => {
    const html = renderToStaticMarkup(
      createElement(AstryxToggle, { checked: false, onChange: vi.fn() })
    )

    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('data-state="unchecked"')
    expect(html).toContain('border-ds-border-strong bg-ds-subtle')
    expect(html).toContain('translate-x-0')
    expect(html).toContain('lucide-minus')
  })
})
