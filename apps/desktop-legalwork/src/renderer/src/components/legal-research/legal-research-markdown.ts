const FENCE_LINE_RE = /^\s*(```|~~~)/
const BOX_DRAWING_RE = /[┌┐└┘├┤┬┴┼─│╭╮╰╯╠╣╦╩╬═║]/
const DIAGRAM_CONTINUATION_RE = /[↓↑→←↔↕]|(?:\|.*\|)|(?:\s{2,}\|)/

export function resolveLegalResearchMarkdown(record: {
  summary: string
  editedSummary?: string
}): string {
  return record.editedSummary ?? record.summary
}

function isMarkdownBoundary(line: string): boolean {
  return /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|~~~)/.test(line)
}

function isDiagramStartLine(line: string): boolean {
  return BOX_DRAWING_RE.test(line)
}

function isDiagramContinuationLine(line: string): boolean {
  if (!line.trim()) return false
  return BOX_DRAWING_RE.test(line) || DIAGRAM_CONTINUATION_RE.test(line)
}

function normalizePlainLine(line: string): string {
  return line
    .replace(/\|\|\|+/g, '\n  - ')
    .replace(/\|\|/g, '\n  - ')
    .trimEnd()
}

export function preprocessLegalResearchSummary(text: string): string {
  if (!text) return ''

  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inFence = false
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence
      out.push(line.trimEnd())
      index += 1
      continue
    }

    if (!inFence && isDiagramStartLine(line)) {
      const diagram: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        if (!isDiagramContinuationLine(current)) break
        if (diagram.length > 0 && isMarkdownBoundary(current)) break
        diagram.push(current.trimEnd())
        index += 1
      }
      out.push('```text', ...diagram, '```')
      continue
    }

    out.push(inFence ? line.trimEnd() : normalizePlainLine(line))
    index += 1
  }

  return out.join('\n').replace(/\n{4,}/g, '\n\n')
}
