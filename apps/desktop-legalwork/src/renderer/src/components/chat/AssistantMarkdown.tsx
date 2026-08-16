import { Component, lazy, Suspense, type ErrorInfo, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkRepairInlineEmphasis } from '../../lib/remark-repair-inline-emphasis'

const LazyStreamdownAssistant = lazy(() =>
  import('./StreamdownAssistant').then((module) => ({ default: module.StreamdownAssistant }))
)

function MarkdownFallback({ text, className }: { text: string; className?: string }): ReactElement {
  return (
    <div
      className={[className, 'break-words'].filter(Boolean).join(' ')}
      data-assistant-markdown-fallback="true"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkRepairInlineEmphasis]}>{text}</ReactMarkdown>
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
      return <MarkdownFallback text={this.props.text} className={this.props.className} />
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
  return (
    <AssistantMarkdownErrorBoundary text={text} className={className}>
      <Suspense fallback={<MarkdownFallback text={text} className={className} />}>
        <LazyStreamdownAssistant text={text} streaming={streaming} className={className} />
      </Suspense>
    </AssistantMarkdownErrorBoundary>
  )
}
