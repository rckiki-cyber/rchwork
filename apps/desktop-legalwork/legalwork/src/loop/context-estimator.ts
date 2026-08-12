import type { TurnItem } from '../contracts/items.js'

/**
 * Small, deliberately conservative token estimator. CJK text is much denser
 * than English in the tokenizer used by our long-context providers, so the
 * old blanket "four characters per token" rule could under-count a Chinese
 * conversation by several hundred thousand tokens and miss compaction.
 */
export class ContextEstimator {
  private readonly charsPerToken: number

  constructor(charsPerToken = 4) {
    this.charsPerToken = charsPerToken
  }

  estimateItem(item: TurnItem): number {
    const text = this.collectText(item)
    return Math.max(1, estimateTextTokens(text, this.charsPerToken))
  }

  estimateItems(items: TurnItem[]): number {
    return items.reduce((sum, item) => sum + this.estimateItem(item), 0)
  }

  private collectText(item: TurnItem): string {
    switch (item.kind) {
      case 'user_message':
      case 'assistant_text':
      case 'assistant_reasoning':
        return item.text
      case 'tool_call':
        return `${item.toolName} ${JSON.stringify(item.arguments)}`
      case 'tool_result':
        return typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
      case 'approval':
        return `${item.toolName} ${item.summary}`
      case 'user_input':
        return item.prompt
      case 'compaction':
        return item.summary
      case 'review':
        return `${item.title} ${item.reviewText ?? ''} ${item.output ? JSON.stringify(item.output) : ''}`
      case 'error':
        return item.message
    }
  }
}

/**
 * Count every CJK code point as one token and amortize the remaining text by
 * the configured Latin-text ratio. This intentionally leaves safety margin:
 * compaction must happen before the provider rejects an oversized request.
 */
export function estimateTextTokens(text: string, charsPerToken = 4): number {
  if (!text) return 0
  const safeCharsPerToken = Number.isFinite(charsPerToken) && charsPerToken > 0
    ? charsPerToken
    : 4
  let cjkCodePoints = 0
  let otherCodeUnits = 0
  for (const codePoint of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(codePoint)) {
      cjkCodePoints += 1
    } else {
      otherCodeUnits += codePoint.length
    }
  }
  return cjkCodePoints + Math.ceil(otherCodeUnits / safeCharsPerToken)
}
