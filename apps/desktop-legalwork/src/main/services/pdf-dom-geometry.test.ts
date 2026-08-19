import { describe, expect, it } from 'vitest'
import { ensurePdfDomGeometry, installPdfDomGeometry } from './pdf-dom-geometry'

class TestDOMMatrix {}
class TestDOMPoint {}
class TestDOMRect {}

describe('PDF DOM geometry compatibility', () => {
  it('installs the pure JavaScript geometry constructors without a native Canvas binding', () => {
    const target: Record<string, unknown> = {}

    installPdfDomGeometry(target, {
      DOMMatrix: TestDOMMatrix,
      DOMPoint: TestDOMPoint,
      DOMRect: TestDOMRect
    })

    expect(target).toMatchObject({
      DOMMatrix: TestDOMMatrix,
      DOMPoint: TestDOMPoint,
      DOMRect: TestDOMRect
    })
  })

  it('fails clearly when the packaged geometry module is incomplete', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'DOMMatrix')
    try {
      Reflect.deleteProperty(globalThis, 'DOMMatrix')
      expect(() => ensurePdfDomGeometry(() => ({}))).toThrow(/did not provide DOMMatrix/)
    } finally {
      if (original) Object.defineProperty(globalThis, 'DOMMatrix', original)
      else Reflect.deleteProperty(globalThis, 'DOMMatrix')
    }
  })
})
