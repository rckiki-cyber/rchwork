export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024

export type TruncationResult = {
  content: string
  truncated: boolean
  truncatedBy: 'lines' | 'bytes' | null
  totalLines: number
  totalBytes: number
  outputLines: number
  outputBytes: number
  lastLinePartial: boolean
  firstLineExceedsLimit: boolean
  maxLines: number
  maxBytes: number
}

export type TruncationOptions = {
  maxLines?: number
  maxBytes?: number
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function truncateStringToBytesFromEnd(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1
  }
  return buffer.subarray(start).toString('utf8')
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const totalBytes = Buffer.byteLength(content, 'utf8')
  const lines = splitLinesForCounting(content)
  const totalLines = lines.length

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes
    }
  }

  const firstLineBytes = Buffer.byteLength(lines[0] ?? '', 'utf8')
  if (firstLineBytes > maxBytes) {
    return {
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes
    }
  }

  const outputLines: string[] = []
  let outputBytes = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'
  for (let index = 0; index < lines.length && index < maxLines; index += 1) {
    const line = lines[index] ?? ''
    const lineBytes = Buffer.byteLength(line, 'utf8') + (index > 0 ? 1 : 0)
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }
    outputLines.push(line)
    outputBytes += lineBytes
  }

  const outputContent = outputLines.join('\n')
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes: Buffer.byteLength(outputContent, 'utf8'),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes
  }
}

export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const totalBytes = Buffer.byteLength(content, 'utf8')
  const lines = splitLinesForCounting(content)
  const totalLines = lines.length

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes
    }
  }

  const outputLines: string[] = []
  let outputBytes = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'
  let lastLinePartial = false
  for (let index = lines.length - 1; index >= 0 && outputLines.length < maxLines; index -= 1) {
    const line = lines[index] ?? ''
    const lineBytes = Buffer.byteLength(line, 'utf8') + (outputLines.length > 0 ? 1 : 0)
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      if (outputLines.length === 0) {
        const partial = truncateStringToBytesFromEnd(line, maxBytes)
        outputLines.unshift(partial)
        outputBytes = Buffer.byteLength(partial, 'utf8')
        lastLinePartial = true
      }
      break
    }
    outputLines.unshift(line)
    outputBytes += lineBytes
  }

  const outputContent = outputLines.join('\n')
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes: Buffer.byteLength(outputContent, 'utf8'),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes
  }
}

/**
 * 工具结果 head/middle/tail 裁剪（对齐 DSH tool-result-pruner）。
 * 文本超 thresholdChars 时保留 head + tail、中间省略并加标记，避免大 tool_result
 * 全量进 history 造成每轮重发 miss。只裁剪文本，不裁剪其它结构。
 */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'
export const DEFAULT_PRUNE_THRESHOLD_CHARS = 8192
export const DEFAULT_PRUNE_HEAD_CHARS = 4096
export const DEFAULT_PRUNE_TAIL_CHARS = 1024

export function pruneLongTextMiddle(
  text: string,
  options: {
    thresholdChars?: number
    headChars?: number
    tailChars?: number
  } = {}
): string {
  const threshold = options.thresholdChars ?? DEFAULT_PRUNE_THRESHOLD_CHARS
  const headChars = options.headChars ?? DEFAULT_PRUNE_HEAD_CHARS
  const tailChars = options.tailChars ?? DEFAULT_PRUNE_TAIL_CHARS
  if (text.length <= threshold) return text
  const head = text.slice(0, headChars)
  const tail = text.slice(-tailChars)
  return `${head}${PRUNE_MARKER}${tail}`
}
