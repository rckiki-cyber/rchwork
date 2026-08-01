import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { FileText, Highlighter, Loader2, MessageSquareText } from 'lucide-react'
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
  textContent: Awaited<ReturnType<pdfjsLib.PDFPageProxy['getTextContent']>> | null
  viewport: ReturnType<pdfjsLib.PDFPageProxy['getViewport']>
}

type PdfHighlightRect = {
  left: number
  top: number
  width: number
  height: number
}

type PdfPageSelection = {
  text: string
  rects: PdfHighlightRect[]
  toolbarLeft: number
  toolbarTop: number
}

export type PdfTextSelection = {
  text: string
  pageNumber: number
}

function PdfSelectablePage({
  page,
  fileName,
  onAskAI
}: {
  page: PdfRenderedPage
  fileName: string
  onAskAI?: (selection: PdfTextSelection) => void
}): ReactElement {
  const pageRef = useRef<HTMLDivElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<PdfPageSelection | null>(null)
  const [highlights, setHighlights] = useState<Array<{ id: number; rects: PdfHighlightRect[] }>>([])

  useEffect(() => {
    const container = textLayerRef.current
    if (!container) return
    container.replaceChildren()
    if (!page.textContent) return
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.textContent,
      container,
      viewport: page.viewport
    })
    void textLayer.render()
    return () => {
      textLayer.cancel()
      container.replaceChildren()
    }
  }, [page])

  const captureSelection = (): void => {
    window.setTimeout(() => {
      const browserSelection = window.getSelection()
      const pageElement = pageRef.current
      const textLayer = textLayerRef.current
      if (!browserSelection || browserSelection.isCollapsed || !pageElement || !textLayer) {
        setSelection(null)
        return
      }
      const anchorInside = Boolean(browserSelection.anchorNode && textLayer.contains(browserSelection.anchorNode))
      const focusInside = Boolean(browserSelection.focusNode && textLayer.contains(browserSelection.focusNode))
      if (!anchorInside || !focusInside || browserSelection.rangeCount === 0) return

      const text = browserSelection.toString().replace(/\s+/g, ' ').trim()
      if (!text) {
        setSelection(null)
        return
      }

      const pageRect = pageElement.getBoundingClientRect()
      const clientRects = Array.from(browserSelection.getRangeAt(0).getClientRects())
        .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
      if (clientRects.length === 0) return

      const rects = clientRects.map((rect) => ({
        left: Math.max(0, rect.left - pageRect.left),
        top: Math.max(0, rect.top - pageRect.top),
        width: Math.min(pageRect.width, rect.width),
        height: Math.min(pageRect.height, rect.height)
      }))
      const bounds = browserSelection.getRangeAt(0).getBoundingClientRect()
      const toolbarWidth = onAskAI ? 150 : 78
      const centeredLeft = bounds.left - pageRect.left + (bounds.width - toolbarWidth) / 2
      const toolbarLeft = Math.max(8, Math.min(pageRect.width - toolbarWidth - 8, centeredLeft))
      const above = bounds.top - pageRect.top - 42
      const toolbarTop = above >= 8
        ? above
        : Math.min(pageRect.height - 40, bounds.bottom - pageRect.top + 8)

      setSelection({
        text: text.slice(0, 6000),
        rects,
        toolbarLeft,
        toolbarTop
      })
    }, 0)
  }

  const clearBrowserSelection = (): void => {
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }

  const addHighlight = (): void => {
    if (!selection) return
    setHighlights((current) => [
      ...current,
      { id: Date.now(), rects: selection.rects }
    ])
    clearBrowserSelection()
  }

  const askAI = (): void => {
    if (!selection || !onAskAI) return
    onAskAI({ text: selection.text, pageNumber: page.pageNumber })
    clearBrowserSelection()
  }

  return (
    <figure className="w-full">
      <div
        ref={pageRef}
        className="relative mx-auto overflow-hidden rounded-[4px] bg-white shadow-sm"
        style={{ width: page.width, height: page.height, maxWidth: '100%' }}
        onMouseUp={captureSelection}
      >
        <img
          src={page.dataUrl}
          alt={`${fileName} 第 ${page.pageNumber} 页`}
          className="block h-full w-full select-none"
          draggable={false}
        />
        <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden="true">
          {highlights.flatMap((highlight) => highlight.rects.map((rect, index) => (
            <span
              key={`${highlight.id}_${index}`}
              className="pdfjs-persistent-highlight absolute rounded-[2px] mix-blend-multiply"
              style={rect}
            />
          )))}
        </div>
        <div ref={textLayerRef} className="textLayer pdfjs-text-layer" />
        {selection ? (
          <div
            data-pdf-selection-toolbar
            className="absolute z-[5] flex h-8 items-center gap-1 rounded-[12px] border border-ds-border bg-[var(--ds-elevated)] p-1 text-[11px] text-[var(--ds-ink)] shadow-[var(--ds-shadow-dropdown)] backdrop-blur-xl"
            style={{ left: selection.toolbarLeft, top: selection.toolbarTop }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <button
              type="button"
              onClick={addHighlight}
              className="flex h-6 items-center gap-1 rounded-[8px] px-2 font-medium transition hover:bg-ds-hover active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]"
              title="高亮选中文字"
            >
              <Highlighter className="h-3.5 w-3.5" strokeWidth={1.8} />
              高亮
            </button>
            {onAskAI ? (
              <button
                type="button"
                onClick={askAI}
                className="flex h-6 items-center gap-1 rounded-[8px] px-2 font-medium text-[var(--ds-accent)] transition hover:bg-[var(--ds-accent-soft)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]"
                title="引用选中文字询问 AI"
              >
                <MessageSquareText className="h-3.5 w-3.5" strokeWidth={1.8} />
                询问 AI
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <figcaption className="mt-2 text-center text-[11px] text-[var(--ds-muted)]">
        第 {page.pageNumber} 页
      </figcaption>
    </figure>
  )
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
  onAskAI?: (selection: PdfTextSelection) => void
}

export function PdfJsPreview({ base64Content, fileName, onAskAI }: Props): ReactElement {
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
      const textLayerPromises: Promise<void>[] = []
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
            dataUrl: canvas.toDataURL('image/png'),
            textContent: null,
            viewport
          }
          setPages((prev) => [...prev, renderedPage])
          setLoading(false)

          const textLayerPromise = withTimeout(
            page.getTextContent(),
            PDF_RENDER_TIMEOUT_MS,
            `第 ${pageNumber} 页文字解析超时`
          ).then((textContent) => {
            if (cancelled) return
            setPages((prev) =>
              prev.map((item) =>
                item.pageNumber === pageNumber ? { ...item, textContent } : item
              )
            )
          }).catch(() => undefined)
          textLayerPromises.push(textLayerPromise)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'PDF 预览渲染失败')
      } finally {
        await Promise.allSettled(textLayerPromises)
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
            <PdfSelectablePage
              key={page.pageNumber}
              page={page}
              fileName={fileName}
              onAskAI={onAskAI}
            />
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
