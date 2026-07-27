import type { ComponentPropsWithRef, MouseEvent, ReactElement } from 'react'
import { Streamdown, type AnimateOptions, type StreamdownProps } from 'streamdown'
import remarkGfm from 'remark-gfm'
import { harden } from 'rehype-harden'
import 'streamdown/styles.css'
import { parseFileReferenceHref, rehypeFileReferences } from '../../lib/file-references'
import { useValidatedFileReference } from '../../lib/file-reference-validation'
import { openWorkspacePathInEditor } from '../../lib/open-workspace-path'
import { previewWorkspaceFile } from '../../lib/workspace-file-preview'
import { useChatStore } from '../../store/chat-store'
import { StreamdownCode } from './StreamdownCode'
import {
  getKnowledgeSourceEntry,
  getKnowledgeSourcePath,
  getKnowledgeOpenFileHandler
} from '../knowledge-base/source-map-store'

/**
 * Tuned for faster, cleaner single-line streaming:
 * - keep per-character reveal for short CJK/plain text
 * - use a quick fade instead of blur
 * - reduce stagger so chunks don't "crawl" across the screen
 */
const STREAMING_ANIMATED: AnimateOptions = {
  sep: 'char',
  duration: 120,
  stagger: 8,
  easing: 'ease-out',
  animation: 'fadeIn'
}

const rehypePlugins = [
  rehypeFileReferences,
  [
    harden,
    {
      allowedLinkPrefixes: ['*']
    }
  ]
] satisfies StreamdownProps['rehypePlugins']

const components = {
  code: StreamdownCode,
  a: StreamdownLink
} satisfies StreamdownProps['components']

type StreamdownLinkProps = ComponentPropsWithRef<'a'> & { node?: unknown }

function StreamdownLink({
  href,
  children,
  className,
  title
}: StreamdownLinkProps): ReactElement {
  const workspaceRoot = useChatStore((s) => s.workspaceRoot)
  const fileTarget = parseFileReferenceHref(href)
  const validation = useValidatedFileReference(fileTarget, workspaceRoot)
  const isKnowledgeSource = Boolean(href?.startsWith('source://'))
  const knowledgeSourceRef = isKnowledgeSource ? href?.replace('source://', '') ?? '' : ''
  const knowledgeSource = isKnowledgeSource ? getKnowledgeSourceEntry(knowledgeSourceRef) : undefined
  const isExternal = href ? /^(https?:|mailto:)/i.test(href) : false
  const cleanClassName = className?.replace(/\bds-file-reference-link\b/g, '').trim()

  if (fileTarget && validation.status !== 'valid') {
    return (
      <span className={cleanClassName} title={title}>
        {children}
      </span>
    )
  }

  const resolvedFileTarget =
    fileTarget && validation.status === 'valid'
      ? { ...fileTarget, path: validation.path }
      : null

  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (isKnowledgeSource) {
      event.preventDefault()
      const path = getKnowledgeSourcePath(knowledgeSourceRef)
      if (path) {
        const handler = getKnowledgeOpenFileHandler()
        if (handler) handler(path)
      }
      return
    }

    if (resolvedFileTarget) {
      event.preventDefault()
      previewWorkspaceFile({ ...resolvedFileTarget, workspaceRoot })
      return
    }

    if (isExternal && href && typeof window.dsGui?.openExternal === 'function') {
      event.preventDefault()
      void window.dsGui.openExternal(href).catch(() => undefined)
    }
  }

  const handleDoubleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!resolvedFileTarget) return
    event.preventDefault()
    void openWorkspacePathInEditor(resolvedFileTarget, workspaceRoot).then((result) => {
      if (!result.ok) {
        void window.dsGui?.logError?.('editor-open', 'Failed to open file reference', {
          message: result.message,
          target: resolvedFileTarget
        })?.catch(() => undefined)
      }
    })
  }

  if (isKnowledgeSource) {
    return (
      <sup className="mx-0.5 inline-flex align-super text-[0.72em] leading-none">
        <a
          href={href}
          title={knowledgeSource?.title || title || '打开引用来源'}
          aria-label={knowledgeSource?.title ? `打开来源：${knowledgeSource.title}` : '打开引用来源'}
          className="inline-flex min-w-[1.35em] items-center justify-center rounded-full border border-[color:var(--ds-accent)]/35 bg-[color:var(--ds-accent)]/10 px-1 py-0.5 font-semibold text-[var(--ds-accent)] no-underline transition hover:bg-[color:var(--ds-accent)]/20"
          onClick={handleClick}
        >
          {children}
        </a>
      </sup>
    )
  }

  return (
    <a
      href={href}
      title={title}
      className={[
        resolvedFileTarget ? 'ds-file-reference-link' : '',
        cleanClassName
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {children}
    </a>
  )
}

const BLOCK_MARKDOWN_REGEX =
  /(^|\n)\s{0,3}(#{1,6}\s|[-+*]\s|\d+\.\s|>\s|```|~~~)|(^|\n)\|.+\|/m

const INLINE_STRUCTURED_MARKDOWN_REGEX =
  /`[^`\n]+`|!\[[^\]]*]\([^)\n]+\)|\[[^\]]+]\([^)\n]+\)/
const MULTILINE_TEXT_REGEX = /\r?\n/
const MAX_ANIMATED_STREAMING_CHARS = 600

export function shouldAnimateStreamingText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.length > MAX_ANIMATED_STREAMING_CHARS) return false
  if (MULTILINE_TEXT_REGEX.test(trimmed)) return false
  return !(
    BLOCK_MARKDOWN_REGEX.test(trimmed) ||
    INLINE_STRUCTURED_MARKDOWN_REGEX.test(trimmed)
  )
}

type Props = {
  /** Markdown source */
  text: string
  /**
   * When true (live SSE chunking), uses Streamdown `streaming` mode with a
   * fast char-level fade so the output feels responsive without the heavy blur.
   */
  streaming: boolean
  className?: string
}

export function StreamdownAssistant({ text, streaming, className }: Props): ReactElement {
  const animated = streaming && shouldAnimateStreamingText(text) ? STREAMING_ANIMATED : false
  const isAnimating = animated !== false

  return (
    <Streamdown
      className={className}
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      isAnimating={isAnimating}
      animated={animated}
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {text}
    </Streamdown>
  )
}
