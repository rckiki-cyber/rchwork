import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactElement,
  type ReactNode
} from 'react'

const LazyStreamdownAssistant = lazy(() =>
  import('./StreamdownAssistant').then((module) => ({ default: module.StreamdownAssistant }))
)

// Plain prose can use the lightweight reveal surface, but structured Markdown
// must stay on Streamdown while it is arriving. Otherwise headings, emphasis,
// lists, tables, and fences remain visible as source text until the turn ends.
const STREAMING_CATCH_UP_FRAMES = 4
const MAX_ANIMATED_STREAM_SEGMENTS = 12
const STREAMING_MARKDOWN_PATTERN =
  /(^|\n)\s{0,3}(#{1,6}(?:\s|$)|[-+*]\s|\d+\.\s|>\s|```|~~~)|(^|\n)\s*\|.+\||\*\*|__|~~|`|!\[[^\]]*\]\(|\[[^\]]+\]\(/m

export function shouldUseLightweightStreaming(text: string, streaming: boolean): boolean {
  return streaming && text.length > 0 && !STREAMING_MARKDOWN_PATTERN.test(text)
}

/**
 * Reveals a growing text buffer over a few animation frames. This absorbs
 * uneven provider chunks without imposing a fixed typewriter speed: a small
 * delta appears on the next frame, while a large burst catches up quickly.
 */
export function nextStreamingRevealLength(currentLength: number, target: string): number {
  if (currentLength >= target.length) return target.length
  const remaining = target.length - currentLength
  let nextLength = Math.min(
    target.length,
    currentLength + Math.max(1, Math.ceil(remaining / STREAMING_CATCH_UP_FRAMES))
  )

  // Never expose half of a UTF-16 surrogate pair while slicing emoji or
  // supplementary CJK characters.
  if (
    nextLength < target.length &&
    target.charCodeAt(nextLength - 1) >= 0xd800 &&
    target.charCodeAt(nextLength - 1) <= 0xdbff &&
    target.charCodeAt(nextLength) >= 0xdc00 &&
    target.charCodeAt(nextLength) <= 0xdfff
  ) {
    nextLength += 1
  }
  return nextLength
}

type StreamingSegment = {
  id: number
  text: string
}

type StreamingVisualFrame = {
  stable: string
  segments: StreamingSegment[]
}

function SmoothPlainTextFallback({
  text,
  className
}: {
  text: string
  className?: string
}): ReactElement {
  const [visualFrame, setVisualFrame] = useState<StreamingVisualFrame>(() => ({
    stable: text,
    segments: []
  }))
  const displayedRef = useRef(text)
  const targetRef = useRef(text)
  const frameRef = useRef<number | null>(null)
  const nextSegmentIdRef = useRef(0)

  useEffect(() => {
    const cancelFrame = (): void => {
      if (frameRef.current === null) return
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    const reset = (value: string): void => {
      displayedRef.current = value
      setVisualFrame({ stable: value, segments: [] })
    }

    const append = (value: string): void => {
      const current = displayedRef.current
      if (!value.startsWith(current)) {
        reset(value)
        return
      }
      const added = value.slice(current.length)
      if (!added) return
      displayedRef.current = value
      const segment: StreamingSegment = {
        id: nextSegmentIdRef.current,
        text: added
      }
      nextSegmentIdRef.current += 1
      setVisualFrame((previous) => {
        let stable = previous.stable
        let segments = previous.segments
        if (segments.length >= MAX_ANIMATED_STREAM_SEGMENTS) {
          const flushCount = segments.length - MAX_ANIMATED_STREAM_SEGMENTS + 1
          stable += segments.slice(0, flushCount).map((item) => item.text).join('')
          segments = segments.slice(flushCount)
        }
        return { stable, segments: [...segments, segment] }
      })
    }

    const revealNextFrame = (): void => {
      frameRef.current = null
      const target = targetRef.current
      const current = displayedRef.current
      if (current === target) return
      if (!target.startsWith(current)) {
        reset(target)
        return
      }
      const nextLength = nextStreamingRevealLength(current.length, target)
      append(target.slice(0, nextLength))
      if (nextLength < target.length) {
        frameRef.current = window.requestAnimationFrame(revealNextFrame)
      }
    }

    const previousTarget = targetRef.current
    targetRef.current = text

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    const canContinue =
      text.startsWith(previousTarget) &&
      text.startsWith(displayedRef.current)

    if (reduceMotion || !canContinue) {
      cancelFrame()
      if (displayedRef.current !== text) reset(text)
      return
    }

    if (frameRef.current === null && displayedRef.current !== text) {
      frameRef.current = window.requestAnimationFrame(revealNextFrame)
    }
  }, [text])

  useEffect(
    () => () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    },
    []
  )

  return (
    <div
      className={[className, 'whitespace-pre-wrap break-words'].filter(Boolean).join(' ')}
      data-assistant-markdown-fallback="true"
      data-smooth-streaming="true"
    >
      {visualFrame.stable}
      {visualFrame.segments.map((segment) => (
        <span key={segment.id} className="ds-streaming-reveal-segment">
          {segment.text}
        </span>
      ))}
    </div>
  )
}

function PlainTextFallback({ text, className }: { text: string; className?: string }): ReactElement {
  return (
    <div
      className={[className, 'whitespace-pre-wrap break-words'].filter(Boolean).join(' ')}
      data-assistant-markdown-fallback="true"
    >
      {text}
    </div>
  )
}

type BoundaryProps = {
  text: string
  className?: string
  children: ReactNode
}

type BoundaryState = { failed: boolean }

class AssistantMarkdownErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Markdown is presentation, not conversation state. A broken lazy chunk,
    // highlighter, Mermaid diagram, or malformed partial document must not
    // reach AppErrorBoundary and tear down the SSE subscription.
    if (typeof window !== 'undefined' && typeof window.dsGui?.logError === 'function') {
      void window.dsGui.logError('renderer', 'Assistant Markdown render failed; using plain text', {
        name: error.name,
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack
      }).catch(() => undefined)
    }
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <PlainTextFallback text={this.props.text} className={this.props.className} />
    }
    return this.props.children
  }
}

export function AssistantMarkdown({
  text,
  streaming,
  className
}: {
  text: string
  streaming: boolean
  className?: string
}): ReactElement {
  const lightweightStreaming = shouldUseLightweightStreaming(text, streaming)

  if (lightweightStreaming) {
    return <SmoothPlainTextFallback text={text} className={className} />
  }

  return (
    <AssistantMarkdownErrorBoundary text={text} className={className}>
      <Suspense fallback={<PlainTextFallback text={text} className={className} />}>
        <LazyStreamdownAssistant text={text} streaming={streaming} className={className} />
      </Suspense>
    </AssistantMarkdownErrorBoundary>
  )
}
