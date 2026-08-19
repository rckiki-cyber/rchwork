import { createRequire } from 'node:module'

export type PdfDomGeometryModule = {
  DOMMatrix?: unknown
  DOMPoint?: unknown
  DOMRect?: unknown
}

const requireFromHere = createRequire(import.meta.url)
const PDF_DOM_GEOMETRY_GLOBALS = ['DOMMatrix', 'DOMPoint', 'DOMRect'] as const

/**
 * pdfjs-dist constructs a DOMMatrix while its module is loading. In Electron's
 * main process that global normally comes from @napi-rs/canvas, but loading the
 * native Canvas binding can fail when an installer contains the wrong CPU
 * architecture. The geometry implementation itself is pure JavaScript, so
 * install it before importing pdf-parse and keep text extraction independent
 * from the optional native renderer.
 */
export function installPdfDomGeometry(
  target: Record<string, unknown>,
  geometry: PdfDomGeometryModule
): void {
  for (const name of PDF_DOM_GEOMETRY_GLOBALS) {
    if (typeof target[name] === 'function') continue
    const implementation = geometry[name]
    if (typeof implementation !== 'function') continue
    Object.defineProperty(target, name, {
      value: implementation,
      configurable: true,
      writable: true
    })
  }
}

export function ensurePdfDomGeometry(
  loadGeometry: () => PdfDomGeometryModule = () => (
    requireFromHere('@napi-rs/canvas/geometry.js') as PdfDomGeometryModule
  )
): void {
  const target = globalThis as unknown as Record<string, unknown>
  if (PDF_DOM_GEOMETRY_GLOBALS.every((name) => typeof target[name] === 'function')) return
  installPdfDomGeometry(target, loadGeometry())
  if (typeof target.DOMMatrix !== 'function') {
    throw new Error('PDF DOM geometry module did not provide DOMMatrix')
  }
}
