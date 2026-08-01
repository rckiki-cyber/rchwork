import { describe, expect, it } from 'vitest'
import { shouldStartLegalResearchFromKeyboard } from './legal-research-keyboard'

describe('legal research keyboard submission', () => {
  it('starts research for an ordinary Enter press', () => {
    expect(shouldStartLegalResearchFromKeyboard({
      key: 'Enter',
      isComposing: false,
      keyCode: 13
    }, false)).toBe(true)
  })

  it('does not start research when Enter confirms an IME candidate', () => {
    expect(shouldStartLegalResearchFromKeyboard({
      key: 'Enter',
      isComposing: true,
      keyCode: 13
    }, true)).toBe(false)
  })

  it('honors the tracked composition state when the browser flag is missing', () => {
    expect(shouldStartLegalResearchFromKeyboard({
      key: 'Enter',
      isComposing: false,
      keyCode: 13
    }, true)).toBe(false)
  })

  it('treats key code 229 as IME input for browser compatibility', () => {
    expect(shouldStartLegalResearchFromKeyboard({
      key: 'Enter',
      isComposing: false,
      keyCode: 229
    }, false)).toBe(false)
  })

  it('ignores non-Enter keys', () => {
    expect(shouldStartLegalResearchFromKeyboard({
      key: 'a',
      isComposing: false,
      keyCode: 65
    }, false)).toBe(false)
  })
})
