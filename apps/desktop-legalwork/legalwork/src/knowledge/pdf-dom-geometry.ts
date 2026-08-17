import { createRequire } from 'node:module'

type PdfDomGeometryModule = {
  DOMMatrix?: unknown
  DOMPoint?: unknown
  DOMRect?: unknown
}

const requireFromHere = createRequire(import.meta.url)

/** Install pdfjs-dist's pure-JavaScript geometry globals before pdf-parse loads. */
export function ensurePdfDomGeometry(): void {
  const target = globalThis as unknown as Record<string, unknown>
  const names = ['DOMMatrix', 'DOMPoint', 'DOMRect'] as const
  if (names.every((name) => typeof target[name] === 'function')) return
  const geometry = requireFromHere('@napi-rs/canvas/geometry.js') as PdfDomGeometryModule
  for (const name of names) {
    if (typeof target[name] === 'function') continue
    const implementation = geometry[name]
    if (typeof implementation !== 'function') continue
    Object.defineProperty(target, name, {
      value: implementation,
      configurable: true,
      writable: true
    })
  }
  if (typeof target.DOMMatrix !== 'function') {
    throw new Error('PDF DOM geometry module did not provide DOMMatrix')
  }
}
