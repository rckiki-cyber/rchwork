import type { MermaidConfig } from '@streamdown/mermaid'
import {
  Check,
  Copy,
  Download,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  X
} from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

const COPY_RESET_MS = 2000
const MIN_ZOOM = 0.55
const MAX_ZOOM = 2
const ZOOM_STEP = 0.15
const MIN_DIAGRAM_WIDTH = 560
const MAX_DIAGRAM_WIDTH = 2400
const VIEWBOX_REGEX = /<svg\b[^>]*\bviewBox=(['"])([^'"]+)\1/i
const FOREIGN_OBJECT_REGEX = /<foreignObject\b([^>]*)>/g
const MERMAID_SOURCE_REGEX =
  /^\s*(?:---[\s\S]*?---\s*)?(?:flowchart|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|C4Context|mindmap|timeline|zenuml|sankey-beta|xychart-beta|block-beta|packet-beta|kanban|architecture-beta)\b/i

type DiagramTheme = 'light' | 'dark'
type RenderState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; svg: string; width: number }
  | { status: 'error'; message: string }

let mermaidRenderQueue: Promise<void> = Promise.resolve()

function enqueueMermaidRender<T>(job: () => Promise<T>): Promise<T> {
  const result = mermaidRenderQueue.then(job, job)
  mermaidRenderQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function currentTheme(): DiagramTheme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function useDiagramTheme(): DiagramTheme {
  const [theme, setTheme] = useState<DiagramTheme>(currentTheme)

  useEffect(() => {
    const root = document.documentElement
    const update = (): void => setTheme(currentTheme())
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return theme
}

export function isMermaidLanguage(language: string): boolean {
  return ['mermaid', 'mmd'].includes(language.trim().toLowerCase())
}

export function looksLikeMermaidSource(source: string): boolean {
  return MERMAID_SOURCE_REGEX.test(source)
}

export function diagramWidthFromSvg(svg: string): number {
  const viewBox = svg.match(VIEWBOX_REGEX)?.[2]?.trim().split(/[\s,]+/).map(Number)
  const width = viewBox?.length === 4 ? viewBox[2] : Number.NaN
  if (!Number.isFinite(width) || width <= 0) return MIN_DIAGRAM_WIDTH
  return Math.max(MIN_DIAGRAM_WIDTH, Math.min(MAX_DIAGRAM_WIDTH, width))
}

export function ensureMermaidLabelVisibility(svg: string): string {
  return svg.replace(FOREIGN_OBJECT_REGEX, (tag, attributes: string) => {
    if (/\boverflow\s*=/.test(attributes)) {
      return tag.replace(/\boverflow\s*=\s*(['"])[^'"]*\1/, 'overflow="visible"')
    }
    return `<foreignObject overflow="visible"${attributes}>`
  })
}

function mermaidConfig(theme: DiagramTheme): MermaidConfig {
  const dark = theme === 'dark'
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei UI", sans-serif',
    themeVariables: dark
      ? {
          background: '#17181c',
          primaryColor: '#24262b',
          primaryTextColor: '#f5f5f7',
          primaryBorderColor: '#555a65',
          secondaryColor: '#1e2938',
          tertiaryColor: '#202226',
          lineColor: '#8993a4',
          textColor: '#f5f5f7',
          edgeLabelBackground: '#17181c',
          clusterBkg: '#202226',
          clusterBorder: '#454a54',
          fontSize: '15px'
        }
      : {
          background: '#ffffff',
          primaryColor: '#f7f9fc',
          primaryTextColor: '#1d1d1f',
          primaryBorderColor: '#c8d0dc',
          secondaryColor: '#edf4ff',
          tertiaryColor: '#f7f8fa',
          lineColor: '#778397',
          textColor: '#1d1d1f',
          edgeLabelBackground: '#ffffff',
          clusterBkg: '#f7f8fa',
          clusterBorder: '#d8dde6',
          fontSize: '15px'
        },
    flowchart: {
      curve: 'linear',
      htmlLabels: false,
      nodeSpacing: 42,
      rankSpacing: 54,
      useMaxWidth: false
    },
    sequence: {
      useMaxWidth: false,
      actorMargin: 64,
      messageMargin: 42,
      diagramMarginX: 24,
      diagramMarginY: 24
    }
  }
}

async function renderMermaid(
  source: string,
  theme: DiagramTheme,
  id: string
): Promise<{ svg: string; width: number }> {
  return enqueueMermaidRender(async () => {
    const { createMermaidPlugin } = await import('@streamdown/mermaid')
    const plugin = createMermaidPlugin({ config: mermaidConfig(theme) })
    const result = await plugin.getMermaid().render(id, source)
    const svg = ensureMermaidLabelVisibility(result.svg)
    return { svg, width: diagramWidthFromSvg(svg) }
  })
}

function downloadSvg(svg: string): void {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'legalwork-flowchart.svg'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function IconButton({
  title,
  onClick,
  children,
  disabled = false
}: {
  title: string
  onClick: () => void
  children: ReactElement
  disabled?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      className="ds-mermaid-action"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function DiagramViewport({
  svg,
  width,
  fullscreen = false
}: {
  svg: string
  width: number
  fullscreen?: boolean
}): ReactElement {
  const { t } = useTranslation()
  const [zoom, setZoom] = useState(1)
  const scaledWidth = Math.round(width * zoom)

  const changeZoom = (delta: number): void => {
    setZoom((value) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value + delta)))
  }

  return (
    <div
      className={`ds-mermaid-viewport${fullscreen ? ' is-fullscreen' : ''}`}
      data-streamdown="mermaid"
    >
      <div className="ds-mermaid-zoom-controls" aria-label={t('mermaidZoomControls')}>
        <IconButton
          title={t('mermaidZoomOut')}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => changeZoom(-ZOOM_STEP)}
        >
          <Minus className="h-3.5 w-3.5" strokeWidth={2} />
        </IconButton>
        <span className="ds-mermaid-zoom-value">{Math.round(zoom * 100)}%</span>
        <IconButton
          title={t('mermaidZoomIn')}
          disabled={zoom >= MAX_ZOOM}
          onClick={() => changeZoom(ZOOM_STEP)}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
        </IconButton>
        <IconButton title={t('mermaidZoomReset')} onClick={() => setZoom(1)}>
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.9} />
        </IconButton>
      </div>
      <div className="ds-mermaid-scroll">
        <div
          className="ds-mermaid-canvas"
          style={{ width: `${scaledWidth}px` }}
          role="img"
          aria-label={t('mermaidDiagramLabel')}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  )
}

export function MermaidDiagram({
  code,
  isIncomplete = false
}: {
  code: string
  isIncomplete?: boolean
}): ReactElement {
  const { t } = useTranslation()
  const source = useMemo(() => code.replace(/\n+$/, ''), [code])
  const theme = useDiagramTheme()
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const renderAttemptRef = useRef(0)
  const [retryKey, setRetryKey] = useState(0)
  const [renderState, setRenderState] = useState<RenderState>({ status: 'idle' })
  const [copied, setCopied] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const copyResetRef = useRef<number | null>(null)

  useEffect(() => {
    if (isIncomplete || !source.trim()) {
      setRenderState({ status: 'idle' })
      return
    }

    let cancelled = false
    const attempt = ++renderAttemptRef.current
    setRenderState({ status: 'loading' })

    void renderMermaid(source, theme, `legalwork-mermaid-${reactId}-${attempt}`).then(
      (result) => {
        if (!cancelled) setRenderState({ status: 'ready', ...result })
      },
      (error: unknown) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : '无法解析这张流程图'
        setRenderState({ status: 'error', message })
      }
    )

    return () => {
      cancelled = true
    }
  }, [isIncomplete, reactId, retryKey, source, theme])

  useEffect(() => {
    if (!fullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [fullscreen])

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
    },
    []
  )

  const handleCopy = async (): Promise<void> => {
    if (!navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => setCopied(false), COPY_RESET_MS)
    } catch {
      setCopied(false)
    }
  }

  const ready = renderState.status === 'ready' ? renderState : null

  return (
    <div className="ds-mermaid-block" data-streamdown="mermaid-block">
      <div className="ds-mermaid-header">
        <div className="ds-mermaid-title">
          <span className="ds-mermaid-title-mark" aria-hidden="true" />
          <span>{t('mermaidTitle')}</span>
          <span className="ds-mermaid-format">Mermaid</span>
        </div>
        <div className="ds-mermaid-actions">
          <IconButton
            title={copied ? t('mermaidSourceCopied') : t('mermaidCopySource')}
            onClick={() => void handleCopy()}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" strokeWidth={2.1} />
            ) : (
              <Copy className="h-3.5 w-3.5" strokeWidth={1.9} />
            )}
          </IconButton>
          <IconButton
            title={t('mermaidDownloadSvg')}
            disabled={!ready}
            onClick={() => ready && downloadSvg(ready.svg)}
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.9} />
          </IconButton>
          <IconButton
            title={t('mermaidViewFullscreen')}
            disabled={!ready}
            onClick={() => ready && setFullscreen(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.9} />
          </IconButton>
        </div>
      </div>

      {isIncomplete ? (
        <div className="ds-mermaid-status">{t('mermaidReceiving')}</div>
      ) : renderState.status === 'loading' || renderState.status === 'idle' ? (
        <div className="ds-mermaid-status">
          <span className="ds-mermaid-spinner" aria-hidden="true" />
          {t('mermaidRendering')}
        </div>
      ) : renderState.status === 'error' ? (
        <div className="ds-mermaid-error" role="alert">
          <div>
            <strong>{t('mermaidRenderFailed')}</strong>
            <p>{renderState.message}</p>
          </div>
          <button type="button" onClick={() => setRetryKey((value) => value + 1)}>
            {t('mermaidRetry')}
          </button>
          <details>
            <summary>{t('mermaidViewSource')}</summary>
            <pre>{source}</pre>
          </details>
        </div>
      ) : ready ? (
        <DiagramViewport svg={ready.svg} width={ready.width} />
      ) : null}

      {fullscreen && ready && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="ds-mermaid-fullscreen"
              role="dialog"
              aria-modal="true"
              aria-label={t('mermaidFullscreenLabel')}
            >
              <div className="ds-mermaid-fullscreen-header">
                <span>{t('mermaidTitle')}</span>
                <IconButton title={t('mermaidExitFullscreen')} onClick={() => setFullscreen(false)}>
                  <X className="h-4 w-4" strokeWidth={1.9} />
                </IconButton>
              </div>
              <DiagramViewport svg={ready.svg} width={ready.width} fullscreen />
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
