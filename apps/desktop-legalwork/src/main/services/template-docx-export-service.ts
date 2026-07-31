import { createRequire } from 'node:module'

type ZipFile = {
  async(type: 'string'): Promise<string>
}

type JSZipInstance = {
  file(path: string): ZipFile | null
  file(path: string, content: string): JSZipInstance
  generateAsync(options: { type: 'nodebuffer'; compression: 'DEFLATE' }): Promise<Buffer>
}

type JSZipConstructor = {
  loadAsync(data: Buffer): Promise<JSZipInstance>
}

const require = createRequire(import.meta.url)
const JSZip = require('jszip') as JSZipConstructor

export type TemplateDocxFillResult = {
  buffer: Buffer
  sourceSlotCount: number
  generatedBlockCount: number
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function splitMarkdownTableRow(line: string): string[] {
  const source = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (const character of source) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }
  cells.push(current.trim())
  return cells
}

function isTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function plainMarkdownText(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|span|strong|em|u|b|i|table|thead|tbody|tr|th|td|ul|ol|li|blockquote|h[1-6])\b[^>]*>/gi, '')
    .trim()
}

export function markdownToTemplateBlocks(markdown: string): string[] {
  const blocks: string[] = []
  let inFence = false
  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      if (line) blocks.push(line)
      continue
    }
    if (!line || /^-{3,}$/.test(line)) continue
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = splitMarkdownTableRow(line)
      if (!isTableSeparator(cells)) {
        blocks.push(...cells.map(plainMarkdownText).filter(Boolean))
      }
      continue
    }
    const text = plainMarkdownText(line)
    if (text) blocks.push(text)
  }
  return blocks
}

function paragraphText(paragraphXml: string): string {
  return [...paragraphXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlText(match[1] ?? ''))
    .join('')
}

function isEditableParagraph(paragraphXml: string): boolean {
  if (!paragraphText(paragraphXml).trim()) return false
  return !/<w:(?:fldChar|instrText|drawing|pict|object)\b/.test(paragraphXml)
}

function replaceParagraphText(paragraphXml: string, replacement: string): string {
  const originalParts = [...paragraphXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlText(match[1] ?? ''))
  const original = originalParts.join('')
  if (original.trim() === replacement.trim()) return paragraphXml

  let prefixLength = 0
  const maxPrefix = Math.min(original.length, replacement.length)
  while (
    prefixLength < maxPrefix &&
    original[prefixLength] === replacement[prefixLength]
  ) {
    prefixLength += 1
  }

  let suffixLength = 0
  const maxSuffix = Math.min(
    original.length - prefixLength,
    replacement.length - prefixLength
  )
  while (
    suffixLength < maxSuffix &&
    original[original.length - 1 - suffixLength] ===
      replacement[replacement.length - 1 - suffixLength]
  ) {
    suffixLength += 1
  }

  const changedOriginalEnd = original.length - suffixLength
  const changedReplacement = replacement.slice(
    prefixLength,
    replacement.length - suffixLength
  )
  let sourceOffset = 0
  let changedInserted = false
  let partIndex = 0
  return paragraphXml.replace(
    /<w:t\b[^>]*>[\s\S]*?<\/w:t>/g,
    () => {
      const originalPart = originalParts[partIndex] ?? ''
      partIndex += 1
      const partStart = sourceOffset
      const partEnd = partStart + originalPart.length
      sourceOffset = partEnd

      let nextText = ''
      if (partStart < prefixLength) {
        nextText += replacement.slice(partStart, Math.min(partEnd, prefixLength))
      }
      if (!changedInserted && partEnd > prefixLength && partStart < changedOriginalEnd) {
        nextText += changedReplacement
        changedInserted = true
      }
      if (partEnd > changedOriginalEnd) {
        const suffixOffset = Math.max(0, partStart - changedOriginalEnd)
        nextText += replacement.slice(replacement.length - suffixLength + suffixOffset)
      }
      return `<w:t xml:space="preserve">${escapeXmlText(nextText)}</w:t>`
    }
  )
}

function clearParagraphText(paragraphXml: string): string {
  return paragraphXml.replace(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g, '<w:t></w:t>')
}

function paragraphStyleSignature(paragraphXml: string): string {
  return paragraphXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] ?? '<w:pPr/>'
}

function mostCommonParagraphTemplate(paragraphs: string[]): string {
  const counts = new Map<string, { count: number; paragraph: string }>()
  for (const paragraph of paragraphs) {
    const signature = paragraphStyleSignature(paragraph)
    const current = counts.get(signature)
    counts.set(signature, {
      count: (current?.count ?? 0) + 1,
      paragraph: current?.paragraph ?? paragraph
    })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.paragraph ?? paragraphs[0]!
}

/**
 * Fill a copy of an uploaded DOCX by changing only text in word/document.xml.
 * Styles, numbering, page setup, headers, footers, images, relationships and
 * every other package part remain source-derived and untouched.
 */
export async function fillDocxTemplateWithMarkdown(
  source: Buffer,
  markdown: string
): Promise<TemplateDocxFillResult> {
  const blocks = markdownToTemplateBlocks(markdown)
  if (blocks.length === 0) {
    throw new Error('生成内容为空，无法写入原 Word 模板。')
  }

  const zip = await JSZip.loadAsync(source)
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) {
    throw new Error('原 Word 模板缺少 word/document.xml，文件可能已损坏。')
  }
  const documentXml = await documentFile.async('string')
  const bodyMatch = documentXml.match(/<w:body>([\s\S]*?)<\/w:body>/)
  if (!bodyMatch) {
    throw new Error('原 Word 模板正文结构无效，无法保留版式导出。')
  }

  const sourceBody = bodyMatch[1] ?? ''
  const editableParagraphs = [...sourceBody.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
    .map((match) => match[0])
    .filter(isEditableParagraph)
  if (editableParagraphs.length === 0) {
    throw new Error('原 Word 模板没有可写入的正文段落。')
  }

  let slotIndex = 0
  let filledBody = sourceBody.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (!isEditableParagraph(paragraph)) return paragraph
    const replacement = blocks[slotIndex]
    slotIndex += 1
    return replacement === undefined
      ? clearParagraphText(paragraph)
      : replaceParagraphText(paragraph, replacement)
  })

  if (blocks.length > editableParagraphs.length) {
    const paragraphTemplate = mostCommonParagraphTemplate(editableParagraphs)
    const appended = blocks
      .slice(editableParagraphs.length)
      .map((block) => replaceParagraphText(paragraphTemplate, block))
      .join('')
    const sectionIndex = filledBody.lastIndexOf('<w:sectPr')
    filledBody = sectionIndex >= 0
      ? `${filledBody.slice(0, sectionIndex)}${appended}${filledBody.slice(sectionIndex)}`
      : `${filledBody}${appended}`
  }

  const filledDocumentXml = documentXml.replace(
    /<w:body>[\s\S]*?<\/w:body>/,
    `<w:body>${filledBody}</w:body>`
  )
  zip.file('word/document.xml', filledDocumentXml)

  return {
    buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    sourceSlotCount: editableParagraphs.length,
    generatedBlockCount: blocks.length
  }
}
