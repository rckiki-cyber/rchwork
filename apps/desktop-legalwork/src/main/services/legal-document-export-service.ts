import { createRequire } from 'node:module'
import { createElement, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import _ReactMarkdown from 'react-markdown'
import _remarkGfm from 'remark-gfm'
import { getLegalDocumentFormatSpec } from '../../shared/legal-document-format'

// react-markdown and remark-gfm are ESM-only ("type": "module"). When
// electron-vite bundles them for the main-process CJS output, the default
// import may resolve to the module namespace object. Handle both CJS/ESM.
const ReactMarkdown = (_ReactMarkdown as { default?: typeof _ReactMarkdown }).default ?? _ReactMarkdown
const remarkGfm = (_remarkGfm as { default?: typeof _remarkGfm }).default ?? _remarkGfm

type HtmlToDocxResult = ArrayBuffer | Blob | Buffer
type HtmlToDocx = (
  html: string,
  header?: string | null,
  options?: Record<string, unknown> | null
) => Promise<HtmlToDocxResult>

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
const htmlToDocx = require('html-to-docx') as HtmlToDocx
const JSZip = require('jszip') as JSZipConstructor

const LEGAL_DOCUMENT_CSS = `
  @page { size: A4; margin: 25.4mm 31.75mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: #000;
    background: #fff;
    font-family: "SimSun", "宋体", serif;
    font-size: 12pt;
    line-height: 1.5;
  }
  .legal-document { width: 100%; }
  .legal-document h1 {
    margin: 0 0 12pt;
    text-align: center;
    font-family: "SimSun", "宋体", serif;
    font-size: 18pt;
    line-height: 1.5;
    font-weight: 700;
    page-break-after: avoid;
  }
  .legal-document h2 {
    margin: 6pt 0;
    font-family: "SimSun", "宋体", serif;
    font-size: 12pt;
    line-height: 1.5;
    font-weight: 700;
    page-break-after: avoid;
  }
  .legal-document h3 {
    margin: 6pt 0;
    font-family: "SimSun", "宋体", serif;
    font-size: 12pt;
    line-height: 1.5;
    font-weight: 400;
    page-break-after: avoid;
  }
  .legal-document h4,
  .legal-document h5,
  .legal-document h6 {
    margin: 6pt 0;
    font-family: "SimSun", "宋体", serif;
    font-size: 12pt;
    line-height: 1.5;
    font-weight: 700;
    page-break-after: avoid;
  }
  .legal-document p {
    margin: 6pt 0;
    text-align: justify;
    text-justify: inter-ideograph;
    text-indent: 2em;
    orphans: 2;
    widows: 2;
  }
  .legal-document p.no-indent,
  .legal-document p.addressee,
  .legal-document p.subject,
  .legal-document p.closing,
  .legal-document p.signature {
    text-indent: 0;
  }
  .legal-document p.addressee,
  .legal-document p.subject { margin-bottom: 3pt; }
  .legal-document p.closing { margin-top: 12pt; }
  .legal-document p.signature {
    margin-left: 50%;
    text-align: left;
    white-space: nowrap;
  }
  .legal-document ul,
  .legal-document ol {
    margin: 6pt 0;
    padding-left: 2em;
    list-style-position: outside;
  }
  .legal-document li {
    margin: 6pt 0;
    text-align: justify;
    line-height: 1.5;
  }
  .legal-document li p {
    margin: 0;
    text-indent: 0;
  }
  .legal-document blockquote {
    margin: 6pt 0;
    padding: 0;
    border: 0;
    color: #000;
  }
  .legal-document hr { display: none; }
  .legal-document table {
    width: 100%;
    margin: 6pt 0;
    border-collapse: collapse;
    font-family: "SimSun", "宋体", serif;
    font-size: 10.5pt;
  }
  .legal-document th,
  .legal-document td {
    border: 1px solid #000;
    padding: 4pt 6pt;
    vertical-align: middle;
    text-align: left;
  }
  .legal-document strong { font-weight: 700; }
  .legal-document a {
    font-family: "SimSun", "宋体", serif;
    color: #0563c1;
    text-decoration: underline;
  }
`

const RESEARCH_TEMPLATE_RE = /法律调研|调研报告|研究报告/
const RESEARCH_METADATA_LABEL_RE =
  /^(?:制定机关|发布机关|效力等级|时效性|施行日期|实施日期|发布日期|失效日期|发文字号|文号)$/
const RESEARCH_METADATA_LINE_RE =
  /^\s*(?:(?:[-*+]|\d+[.)、])\s+)?(?:\*\*)?(制定机关|发布机关|效力等级|时效性|施行日期|实施日期|发布日期|失效日期|发文字号|文号)(?:\*\*)?\s*[：:]/
const RESEARCH_TRAILING_CHAT_RE =
  /^(?:如需|如果需要|若需|我可以|请告诉我|欢迎继续|以上就是|以上为).*(?:补充|调整|修改|帮助|调研|报告|内容)?[。！!]?$/

function splitMarkdownTableRow(line: string): string[] {
  const source = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let escaped = false

  for (const character of source) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      current += character
      continue
    }
    if (character === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  cells.push(current.trim())
  return cells
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function isResearchMetadataCell(value: string): boolean {
  return RESEARCH_METADATA_LABEL_RE.test(
    value
      .replace(/\*\*/g, '')
      .replace(/[：:]\s*$/, '')
      .trim()
  )
}

function proseFromTwoColumnTable(rows: string[][]): string[] {
  return rows.flatMap((row) => {
    const label = row[0]?.replace(/\*\*/g, '').trim()
    const value = row.slice(1).join('；').trim()
    if (!label && !value) return []
    if (!value) return [label]
    return [`**${label}：** ${value}`]
  })
}

function normalizeResearchTables(lines: string[]): string[] {
  const output: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const nextLine = lines[index + 1] ?? ''
    if (!line.trim().startsWith('|') || !isMarkdownTableSeparator(nextLine)) {
      output.push(line)
      index += 1
      continue
    }

    const block: string[] = [line, nextLine]
    index += 2
    while (index < lines.length && (lines[index] ?? '').trim().startsWith('|')) {
      block.push(lines[index] ?? '')
      index += 1
    }

    const header = splitMarkdownTableRow(block[0] ?? '')
    const rows = block
      .slice(2)
      .map(splitMarkdownTableRow)
      .filter((row) => !isResearchMetadataCell(row[0] ?? ''))

    if (rows.length === 0) continue

    if (header.length <= 2) {
      output.push(...proseFromTwoColumnTable(rows).flatMap((paragraph) => [paragraph, '']))
      continue
    }

    output.push(
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...rows.map((row) => `| ${row.join(' | ')} |`)
    )
  }

  return output
}

function normalizeResearchHeadings(lines: string[]): string[] {
  let section = 0
  let subsection = 0
  let item = 0
  let subitem = 0

  const chineseNumber = (value: number): string => {
    const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
    if (value < 10) return digits[value] ?? String(value)
    if (value === 10) return '十'
    if (value < 20) return `十${digits[value % 10] ?? ''}`
    if (value < 100) {
      const ones = value % 10
      return `${digits[Math.floor(value / 10)] ?? ''}十${ones ? digits[ones] : ''}`
    }
    return String(value)
  }

  return lines.map((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!match) return line

    const level = match[1]?.length ?? 0
    const heading = match[2]?.trim() ?? ''
    if (level === 1) return `# ${heading}`

    const withoutNumber = heading
      .replace(/^(?:[一二三四五六七八九十百]+[、.．]|第[一二三四五六七八九十百\d]+[章节部分项][、.．]?|\d+(?:\.\d+)*[、.．]?)\s*/, '')
      .replace(/^[（(][一二三四五六七八九十百\d]+[）)]\s*/, '')

    if (level === 2) {
      section += 1
      subsection = 0
      item = 0
      subitem = 0
      return `## ${chineseNumber(section)}、${withoutNumber}`
    }
    if (level === 3) {
      subsection += 1
      item = 0
      subitem = 0
      return `### （${chineseNumber(subsection)}）${withoutNumber}`
    }
    if (level === 4) {
      item += 1
      subitem = 0
      return `#### ${item}、${withoutNumber}`
    }
    if (level === 5) {
      subitem += 1
      return `##### （${subitem}）${withoutNumber}`
    }
    return `**${withoutNumber}**`
  })
}

export function prepareLegalDocumentMarkdown(options: {
  markdown: string
  templateName: string
}): string {
  const isResearch = RESEARCH_TEMPLATE_RE.test(options.templateName)
  let lines = options.markdown.replace(/\r\n?/g, '\n').split('\n')

  if (isResearch) {
    const firstHeading = lines.findIndex((line) => /^#\s+\S/.test(line))
    if (firstHeading > 0) lines = lines.slice(firstHeading)
    lines = normalizeResearchTables(lines)
    lines = lines.filter((line) => !RESEARCH_METADATA_LINE_RE.test(line))
    lines = normalizeResearchHeadings(lines)
  }

  let inFence = false
  lines = lines.flatMap((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return isResearch ? [] : [line]
    }
    if (inFence && isResearch) return []
    if (inFence) return [line]

    const withoutBullet = line.replace(/^\s*[-*+]\s+(?=\S)/, '')
    const ordered = /^\s*(\d+)[.)、]\s+(.+)$/.exec(withoutBullet)
    if (ordered) {
      if (!isResearch) return [`${ordered[1]}. ${ordered[2]}`, '']
      return [`${ordered[1]}、${ordered[2]}`, '']
    }
    return [withoutBullet]
  })

  if (isResearch) {
    lines = lines.filter((line) => !RESEARCH_TRAILING_CHAT_RE.test(line.trim()))
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function textFromReactNode(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textFromReactNode).join('')
  if (value && typeof value === 'object' && 'props' in value) {
    return textFromReactNode((value as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

function paragraphClass(children: ReactNode): string | undefined {
  const text = textFromReactNode(children).trim()
  if (/^(致|关于|事由|案由|编号)[：:]/.test(text)) return text.startsWith('致') ? 'addressee' : 'subject'
  if (/^此致[！!。.]?$/.test(text)) return 'closing'
  if (/^(申请人|具状人|答辩人|上诉人|委托人|律师事务所|经办律师|律师|日期|签署日期|立遗嘱人|甲方|乙方)[：:]/.test(text)) return 'signature'
  if (/^(尊敬的|敬启者|申请人|被申请人|原告|被告|上诉人|被上诉人|答辩人)[：:]/.test(text)) return 'no-indent'
  return undefined
}

export function renderLegalDocumentMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        components: {
          p: ({ children, ...props }: ComponentPropsWithoutRef<'p'>): ReactNode =>
            createElement('p', { ...props, className: paragraphClass(children) }, children),
          a: ({ href, children }: ComponentPropsWithoutRef<'a'>): ReactNode => {
            if (!href?.trim()) return createElement('span', null, children)
            return createElement('a', { href: href.trim() }, children)
          }
        }
      },
      markdown
    )
  )
}

export function buildLegalDocumentHtml(options: {
  markdown: string
  templateId?: string
  templateName: string
}): string {
  const spec = getLegalDocumentFormatSpec(options.templateId, options.templateName)
  const body = renderLegalDocumentMarkdown(
    prepareLegalDocumentMarkdown({
      markdown: options.markdown,
      templateName: options.templateName
    })
  )
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${options.templateName.replace(/[<>&"]/g, '')}</title>
  <style>${LEGAL_DOCUMENT_CSS}</style>
</head>
<body>
  <article class="legal-document" data-document-archetype="${spec.archetype}">
    ${body}
  </article>
</body>
</html>`
}

function setEastAsianFont(xml: string): string {
  const fonts = '<w:rFonts w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体" w:cs="宋体" w:hint="eastAsia"/>'
  const normalized = xml.replace(/<w:rFonts\b([^>]*?)\/>/g, (_match, attributes: string) => {
    const cleaned = attributes
      .replace(/\s+w:ascii="[^"]*"/g, '')
      .replace(/\s+w:asciiTheme="[^"]*"/g, '')
      .replace(/\s+w:hAnsi="[^"]*"/g, '')
      .replace(/\s+w:hAnsiTheme="[^"]*"/g, '')
      .replace(/\s+w:eastAsia="[^"]*"/g, '')
      .replace(/\s+w:eastAsiaTheme="[^"]*"/g, '')
      .replace(/\s+w:hint="[^"]*"/g, '')
    return `<w:rFonts${cleaned} w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体" w:cs="宋体" w:hint="eastAsia"/>`
  })
  return normalized
    .replace(/\s+w:eastAsia="en-US"/g, ' w:eastAsia="zh-CN"')
    .replace(
      /<w:rPr\/>/g,
      `<w:rPr>${fonts}<w:lang w:eastAsia="zh-CN"/></w:rPr>`
    )
    .replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (runProperties, content: string) => {
      if (/<w:rFonts\b/.test(content)) return runProperties
      const withFont = content.replace(/^(\s*(?:<w:rStyle\b[^>]*\/>)?)/, `$1${fonts}`)
      return `<w:rPr>${withFont}</w:rPr>`
    })
}

function setHeadingEastAsianFonts(xml: string): string {
  return xml.replace(
    /(<w:pStyle w:val="Heading1"\/>[\s\S]*?<w:rPr>)([\s\S]*?)(<\/w:rPr>)/g,
    (_match, start: string, middle: string, end: string) => {
      const fonts = '<w:rFonts w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体" w:cs="宋体" w:hint="eastAsia"/>'
      const formatted = /<w:rFonts\b[^>]*\/>/.test(middle)
        ? middle.replace(/<w:rFonts\b[^>]*\/>/g, fonts)
        : `${fonts}${middle}`
      return `${start}${formatted}${end}`
    }
  )
}

function replaceParagraphProperty(
  properties: string,
  tagName: 'w:spacing' | 'w:ind' | 'w:jc',
  replacement: string
): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*/>`, 'g')
  return `${properties.replace(pattern, '')}${replacement}`
}

export function normalizeLegalParagraphs(xml: string): string {
  const tables: string[] = []
  const withoutTables = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (table) => {
    const index = tables.push(table) - 1
    return `__LEGALWORK_TABLE_${index}__`
  })

  const normalized = withoutTables.replace(/<w:p>([\s\S]*?)<\/w:p>/g, (paragraph, content: string) => {
    const text = [...content.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((match) => match[1])
      .join('')
      .trim()
    if (!text) return ''

    const style = content.match(/<w:pStyle w:val="([^"]+)"\/>/)?.[1]
    const isNumbered = /<w:numPr>[\s\S]*?<\/w:numPr>/.test(content)
    const isSignature = /^(申请人|具状人|答辩人|上诉人|委托人|律师事务所|某.+律师事务所|经办律师|律师|日期|签署日期|立遗嘱人)[：:：]?/.test(text)
    const isNoIndent = /^(致[：:]|关于[：:]|事由[：:]|案由[：:]|编号[：:]|此致[！!。.]?$)/.test(text)

    let properties = content.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)?.[1] ?? ''
    properties = replaceParagraphProperty(
      properties,
      'w:spacing',
      style === 'Heading1'
        ? '<w:spacing w:before="0" w:after="240" w:line="540" w:lineRule="auto"/>'
        : style === 'Heading2'
          ? '<w:spacing w:before="156" w:after="156" w:line="360" w:lineRule="auto"/>'
          : style === 'Heading3'
            ? '<w:spacing w:before="156" w:after="156" w:line="360" w:lineRule="auto"/>'
            : '<w:spacing w:before="156" w:after="156" w:line="360" w:lineRule="auto"/>'
    )
    properties = replaceParagraphProperty(
      properties,
      'w:ind',
      isNumbered
        ? '<w:ind w:left="480" w:hanging="360"/>'
        : style || isNoIndent || isSignature
          ? '<w:ind w:firstLine="0" w:firstLineChars="0"/>'
          : '<w:ind w:firstLine="480" w:firstLineChars="200"/>'
    )
    properties = replaceParagraphProperty(
      properties,
      'w:jc',
      style === 'Heading1'
        ? '<w:jc w:val="center"/>'
        : isSignature
          ? '<w:jc w:val="right"/>'
          : '<w:jc w:val="both"/>'
    )

    const pPr = `<w:pPr>${properties}</w:pPr>`
    const normalizedContent = /<w:pPr>[\s\S]*?<\/w:pPr>/.test(content)
      ? content.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, pPr)
      : `${pPr}${content}`
    return `<w:p>${normalizedContent}</w:p>`
  })

  return normalized.replace(/__LEGALWORK_TABLE_(\d+)__/g, (_marker, index: string) => (
    tables[Number(index)] ?? ''
  ))
}

function moveSectionPropertiesToBodyEnd(xml: string): string {
  return xml.replace(/<w:body>([\s\S]*?)<\/w:body>/, (_body, content: string) => {
    const sections = [...content.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)]
      .map((match) => match[0])
    if (sections.length === 0) return `<w:body>${content}</w:body>`
    const withoutSections = content.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, '')
    return `<w:body>${withoutSections}${sections.at(-1)}</w:body>`
  })
}

function normalizeLegalStyles(xml: string): string {
  const sizeByStyle: Record<string, string> = {
    Heading1: '36',
    Heading2: '24',
    Heading3: '24'
  }
  let normalized = xml
  for (const [styleId, size] of Object.entries(sizeByStyle)) {
    const stylePattern = new RegExp(
      `(<w:style\\b[^>]*w:styleId="${styleId}"[^>]*>[\\s\\S]*?<w:rPr>)([\\s\\S]*?)(</w:rPr>[\\s\\S]*?</w:style>)`
    )
    normalized = normalized.replace(stylePattern, (_match, start: string, runProps: string, end: string) => {
      let withoutSize = runProps
        .replace(/<w:sz\b[^>]*\/>/g, '')
        .replace(/<w:szCs\b[^>]*\/>/g, '')
      if (styleId === 'Heading3') {
        withoutSize = withoutSize
          .replace(/<w:b\b[^>]*\/>/g, '')
          .replace(/<w:bCs\b[^>]*\/>/g, '')
      }
      return `${start}${withoutSize}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${end}`
    })
  }
  return normalized
}

async function normalizeLegalDocxFonts(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer)
  for (const path of ['word/styles.xml', 'word/document.xml', 'word/numbering.xml', 'word/fontTable.xml']) {
    const file = zip.file(path)
    if (!file) continue
    const original = await file.async('string')
    let normalized = path === 'word/document.xml'
      ? moveSectionPropertiesToBodyEnd(
          normalizeLegalParagraphs(setHeadingEastAsianFonts(setEastAsianFont(original)))
        )
      : path === 'word/styles.xml'
        ? normalizeLegalStyles(setEastAsianFont(original))
        : setEastAsianFont(original)
    if (path === 'word/fontTable.xml' && !normalized.includes('w:name="宋体"')) {
      normalized = normalized.replace(
        '</w:fonts>',
        '<w:font w:name="宋体"><w:charset w:val="86"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font></w:fonts>'
      )
    }
    zip.file(path, normalized)
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function toBuffer(result: HtmlToDocxResult): Promise<Buffer> {
  if (Buffer.isBuffer(result)) return result
  if (result instanceof ArrayBuffer) return Buffer.from(new Uint8Array(result))
  return Buffer.from(await result.arrayBuffer())
}

export async function legalDocumentMarkdownToDocx(options: {
  markdown: string
  templateId?: string
  templateName: string
}): Promise<Buffer> {
  const html = buildLegalDocumentHtml(options)
  const result = await htmlToDocx(html, null, {
    title: options.templateName,
    creator: 'legalwork',
    keywords: ['法律文书', options.templateName],
    description: `legalwork 生成的${options.templateName}`,
    font: 'SimSun',
    fontSize: 24,
    pageSize: { width: 11906, height: 16838 },
    margins: { top: 1440, right: 1800, bottom: 1440, left: 1800, header: 851, footer: 992, gutter: 0 }
  })
  return normalizeLegalDocxFonts(await toBuffer(result))
}
