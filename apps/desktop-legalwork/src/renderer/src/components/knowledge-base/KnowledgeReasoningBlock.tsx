import type { ReactElement } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'

export type KnowledgeAssistantParts = {
  content: string
  reasoning: string
}

const LEGACY_REASONING_DETAILS_RE =
  /^\s*<details\b[^>]*>\s*<summary\b[^>]*>[\s\S]*?思考过程[\s\S]*?<\/summary>\s*([\s\S]*?)\s*<\/details>\s*([\s\S]*)$/i

export function splitLegacyKnowledgeReasoning(content: string): KnowledgeAssistantParts {
  const match = LEGACY_REASONING_DETAILS_RE.exec(content)
  if (!match) return { content, reasoning: '' }
  return {
    reasoning: match[1]?.trim() ?? '',
    content: match[2]?.trim() ?? ''
  }
}

export function KnowledgeAssistantContent({
  content,
  reasoning
}: {
  content: string
  reasoning?: string
}): ReactElement {
  const legacyParts = reasoning === undefined
    ? splitLegacyKnowledgeReasoning(content)
    : { content, reasoning }

  return (
    <div className="min-w-0">
      {legacyParts.reasoning ? (
        <details className="group/reasoning mb-3 rounded-[8px] border border-ds-border bg-ds-card/55">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[11.5px] font-medium text-[var(--ds-muted)] outline-none transition hover:text-[var(--ds-ink)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent)]">
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 transition-transform group-open/reasoning:rotate-90"
              strokeWidth={1.8}
            />
            <Brain className="h-3.5 w-3.5 shrink-0 opacity-65" strokeWidth={1.7} />
            <span>思考过程</span>
          </summary>
          <div className="border-t border-ds-border px-3 py-2.5 text-[12px] leading-relaxed text-[var(--ds-muted)]">
            <AssistantMarkdown
              text={legacyParts.reasoning}
              streaming={false}
              className="ds-markdown ds-chat-answer break-words !text-[12px]"
            />
          </div>
        </details>
      ) : null}
      <AssistantMarkdown
        text={legacyParts.content}
        streaming={false}
        className="ds-markdown ds-chat-answer break-words !text-[13px] leading-relaxed"
      />
    </div>
  )
}
