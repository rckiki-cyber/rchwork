import { Component, lazy, Suspense, type ErrorInfo, type ReactElement, type ReactNode } from 'react'

const LazyStreamdownAssistant = lazy(() =>
  import('./StreamdownAssistant').then((module) => ({ default: module.StreamdownAssistant }))
)

// Parsing the complete Markdown document for every token becomes visibly
// expensive on long research and drafting turns. Keep the live tail cheap;
// the completed answer is rendered as rich Markdown once streaming stops.
const MAX_RICH_STREAMING_CHARS = 8_000

export function shouldUseLightweightStreaming(text: string, streaming: boolean): boolean {
  return streaming && text.length > MAX_RICH_STREAMING_CHARS
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
  if (shouldUseLightweightStreaming(text, streaming)) {
    return <PlainTextFallback text={text} className={className} />
  }

  return (
    <AssistantMarkdownErrorBoundary text={text} className={className}>
      <Suspense fallback={<PlainTextFallback text={text} className={className} />}>
        <LazyStreamdownAssistant text={text} streaming={streaming} className={className} />
      </Suspense>
    </AssistantMarkdownErrorBoundary>
  )
}
