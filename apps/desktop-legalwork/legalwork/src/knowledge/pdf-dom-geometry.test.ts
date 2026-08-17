import { describe, expect, it } from 'vitest'
import { ensurePdfDomGeometry } from './pdf-dom-geometry.js'

describe('PDF DOM geometry compatibility', () => {
  it('loads DOMMatrix from the packaged pure JavaScript geometry module', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'DOMMatrix')
    try {
      Reflect.deleteProperty(globalThis, 'DOMMatrix')
      ensurePdfDomGeometry()
      expect(typeof (globalThis as unknown as Record<string, unknown>).DOMMatrix).toBe('function')
    } finally {
      if (original) Object.defineProperty(globalThis, 'DOMMatrix', original)
      else Reflect.deleteProperty(globalThis, 'DOMMatrix')
    }
  })
})
