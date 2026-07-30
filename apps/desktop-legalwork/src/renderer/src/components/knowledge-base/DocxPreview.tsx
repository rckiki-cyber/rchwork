import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { File, Loader2 } from 'lucide-react'

type DocxPreviewProps = {
  base64Content: string
  fileName: string
  fallbackText: string
}

function decodeBase64(base64Content: string): Uint8Array {
  const byteString = atob(base64Content)
  const bytes = new Uint8Array(byteString.length)
  for (let index = 0; index < byteString.length; index += 1) {
    bytes[index] = byteString.charCodeAt(index)
  }
  return bytes
}

export function DocxPreview({
  base64Content,
  fileName,
  fallbackText
}: DocxPreviewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderVersionRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const previewContainer: HTMLDivElement = container

    const renderVersion = renderVersionRef.current + 1
    renderVersionRef.current = renderVersion
    let cancelled = false
    setLoading(true)
    setError(null)

    async function renderDocument(): Promise<void> {
      try {
        const stagedBody = document.createElement('div')
        const stagedStyles = document.createElement('div')
        const bytes = decodeBase64(base64Content)
        const { renderAsync } = await import('docx-preview')
        await renderAsync(bytes, stagedBody, stagedStyles, {
          className: 'legalwork-docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          experimental: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderChanges: false,
          renderComments: false,
          renderAltChunks: false
        })

        if (cancelled || renderVersionRef.current !== renderVersion) return
        previewContainer.replaceChildren(
          ...Array.from(stagedStyles.childNodes),
          ...Array.from(stagedBody.childNodes)
        )
      } catch (renderError) {
        if (cancelled || renderVersionRef.current !== renderVersion) return
        previewContainer.replaceChildren()
        setError(renderError instanceof Error ? renderError.message : 'Word 文档渲染失败')
      } finally {
        if (!cancelled && renderVersionRef.current === renderVersion) {
          setLoading(false)
        }
      }
    }

    void renderDocument()
    return () => {
      cancelled = true
      if (renderVersionRef.current === renderVersion) {
        renderVersionRef.current += 1
      }
    }
  }, [base64Content])

  return (
    <div className="docx-layout-preview relative min-h-full">
      <div ref={containerRef} className="docx-layout-preview__content min-h-full" />

      {loading ? (
        <div className="absolute inset-0 flex min-h-[240px] items-center justify-center bg-[var(--ds-main)]/88 text-[13px] text-[var(--ds-muted)] backdrop-blur-[2px]">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
            正在还原 {fileName} 的 Word 版式…
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 px-8 py-12 text-center text-[13px] text-[var(--ds-muted)]">
          <File className="h-10 w-10 text-[var(--ds-faint)]" strokeWidth={1.4} />
          <div className="font-medium text-[var(--ds-ink)]">Word 版式预览失败</div>
          <div className="max-w-xl text-[12px] leading-5">{error}</div>
          {fallbackText ? (
            <pre className="mt-3 max-h-[360px] w-full max-w-3xl overflow-auto whitespace-pre-wrap rounded-xl border border-ds-border bg-ds-card p-4 text-left font-sans text-[13px] leading-6 text-[var(--ds-ink)]">
              {fallbackText}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
