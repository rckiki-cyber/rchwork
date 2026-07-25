import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const PDF_RENDER_TIMEOUT_MS = 20000
const PDFJS_ASSET_BASE_URL = new URL('pdfjs/', window.location.href).toString()

type PdfRenderedPage = {
  pageNumber: number
  width: number
  height: number
  dataUrl: string
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

function base64ToBytes(base64Content: string): Uint8Array {
  const byteString = atob(base64Content)
  const bytes = new Uint8Array(byteString.length)
  for (let i = 0; i < byteString.length; i += 1) {
    bytes[i] = byteString.charCodeAt(i)
  }
  return bytes
}

export async function extractPdfTextFromBase64(base64Content: string, maxChars = 30000): Promise<string> {
  if (!base64Content) return ''
  let pdf: pdfjsLib.PDFDocumentProxy | null = null
  try {
    pdf = await withTimeout(
      pdfjsLib.getDocument({
        data: base64ToBytes(base64Content),
        cMapUrl: `${PDFJS_ASSET_BASE_URL}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_ASSET_BASE_URL}standard_fonts/`
      }).promise,
      PDF_RENDER_TIMEOUT_MS,
      'PDF 文本读取超时'
    )
    const chunks: string[] = []
    let totalLength = 0
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await withTimeout(pdf.getPage(pageNumber), PDF_RENDER_TIMEOUT_MS, `第 ${pageNumber} 页文本读取超时`)
      const textContent = await withTimeout(page.getTextContent(), PDF_RENDER_TIMEOUT_MS, `第 ${pageNumber} 页文本解析超时`)
      const pageText = textContent.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (pageText) {
        const chunk = `第 ${pageNumber} 页：\n${pageText}`
        chunks.push(chunk)
        totalLength += chunk.length
      }
      if (totalLength >= maxChars) break
    }
    return chunks.join('\n\n').slice(0, maxChars)
  } finally {
    if (pdf) void pdf.destroy()
  }
}

type Props = {
  base64Content: string
  fileName: string
}

export function PdfJsPreview({ base64Content, fileName }: Props): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderKeyRef = useRef<string>('')
  const renderWidthRef = useRef(480)
  const [pages, setPages] = useState<PdfRenderedPage[]>([])
  const [loading, setLoading] = useState(false)
  const [renderingMore, setRenderingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Measure container width once on mount via a ref; ResizeObserver updates
  // the ref but never re-renders, preventing the flash-loop from PDF re-render.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const updateWidth = (): void => {
      const width = Math.floor(element.clientWidth)
      if (width <= 0) return
      renderWidthRef.current = Math.min(Math.max(width - 32, 280), 960)
    }
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const renderPdf = async (): Promise<void> => {
      if (!base64Content) return
      const w = renderWidthRef.current
      if (w <= 0) return
      const renderKey = `${base64Content.length}:${w}`
      if (renderKeyRef.current === renderKey) return
      renderKeyRef.current = renderKey
      setLoading(true)
      setRenderingMore(false)
      setError(null)
      setPages([])
      let pdf: pdfjsLib.PDFDocumentProxy | null = null
      try {
        pdf = await withTimeout(
          pdfjsLib.getDocument({
            data: base64ToBytes(base64Content),
            cMapUrl: `${PDFJS_ASSET_BASE_URL}cmaps/`,
            cMapPacked: true,
            standardFontDataUrl: `${PDFJS_ASSET_BASE_URL}standard_fonts/`
          }).promise,
          PDF_RENDER_TIMEOUT_MS,
          'PDF 加载超时'
        )
        const renderedPages: PdfRenderedPage[] = []
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          if (cancelled) break
          if (pageNumber > 1) {
            setLoading(false)
            setRenderingMore(true)
          }
          const page = await withTimeout(pdf.getPage(pageNumber), PDF_RENDER_TIMEOUT_MS, `第 ${pageNumber} 页读取超时`)
          const baseViewport = page.getViewport({ scale: 1 })
          const scale = w / baseViewport.width
          const viewport = page.getViewport({ scale })
          const canvas = document.createElement('canvas')
          const context = canvas.getContext('2d')
          if (!context) throw new Error('无法创建 PDF 预览画布')
          const ratio = window.devicePixelRatio || 1
          canvas.width = Math.floor(viewport.width * ratio)
          canvas.height = Math.floor(viewport.height * ratio)
          canvas.style.width = `${viewport.width}px`
          canvas.style.height = `${viewport.height}px`
          context.setTransform(ratio, 0, 0, ratio, 0, 0)
          await withTimeout(
            page.render({ canvas, canvasContext: context, viewport }).promise,
            PDF_RENDER_TIMEOUT_MS,
            `第 ${pageNumber} 页渲染超时`
          )
          if (cancelled) break
          const renderedPage: PdfRenderedPage = {
            pageNumber,
            width: viewport.width,
            height: viewport.height,
            dataUrl: canvas.toDataURL('image/png')
          }
          renderedPages.push(renderedPage)
          setPages((prev) => [...prev, renderedPage])
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'PDF 预览渲染失败')
      } finally {
        if (pdf) void pdf.destroy()
        if (!cancelled) setLoading(false)
        if (!cancelled) setRenderingMore(false)
      }
    }
    void renderPdf()
    return () => {
      cancelled = true
    }
  }, [base64Content])

  return (
    <div ref={containerRef} className="min-h-full bg-[var(--ds-main)]">
      {loading && pages.length === 0 ? (
        <div className="flex h-full min-h-[320px] items-center justify-center gap-2 text-[13px] text-[var(--ds-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
          正在渲染 PDF...
        </div>
      ) : null}
      {error ? (
        <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-[var(--ds-muted)]">
          <FileText className="h-10 w-10 text-slate-300" strokeWidth={1.4} />
          <div className="font-medium text-[var(--ds-ink)]">PDF 预览失败</div>
          <div className="max-w-sm break-words">{error}</div>
        </div>
      ) : null}
      {pages.length > 0 ? (
        <div className="flex flex-col items-center gap-4 p-4">
          {pages.map((page) => (
            <figure key={page.pageNumber} className="w-full">
              <img
                src={page.dataUrl}
                alt={`${fileName} 第 ${page.pageNumber} 页`}
                className="mx-auto max-w-full rounded-[4px] bg-white shadow-sm"
                style={{ width: page.width, minHeight: page.height }}
              />
              <figcaption className="mt-2 text-center text-[11px] text-[var(--ds-muted)]">
                第 {page.pageNumber} 页
              </figcaption>
            </figure>
          ))}
          {renderingMore ? (
            <div className="flex items-center gap-2 pb-4 text-[12px] text-[var(--ds-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
              继续渲染...
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
