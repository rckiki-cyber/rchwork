import { createRequire } from 'node:module'
import { createElement, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getLegalDocumentFormatSpec } from '../../shared/legal-document-format'

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
  @page { size: A4; margin: 28mm 25mm 25mm 28mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: #000;
    background: #fff;
    font-family: "FangSong", "STFangsong", "仿宋", serif;
    font-size: 16pt;
    line-height: 1.75;
  }
  .legal-document { width: 100%; }
  .legal-document h1 {
    margin: 0 0 18pt;
    text-align: center;
    font-family: "SimSun", "Arial Unicode MS", "宋体", serif;
    font-size: 22pt;
    line-height: 1.35;
    font-weight: 700;
    page-break-after: avoid;
  }
  .legal-document h2 {
    margin: 12pt 0 3pt;
    font-family: "SimHei", "Heiti SC", "黑体", sans-serif;
    font-size: 16pt;
    line-height: 1.75;
    font-weight: 700;
    page-break-after: avoid;
  }
  .legal-document h3 {
    margin: 6pt 0 2pt;
    font-family: "KaiTi", "Kaiti SC", "楷体", serif;
    font-size: 16pt;
    line-height: 1.75;
    font-weight: 700;
    page-break-after: avoid;
  }
  .legal-document p {
    margin: 0;
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
    margin: 0 0 3pt;
    padding-left: 2.2em;
  }
  .legal-document li {
    margin: 0;
    text-align: justify;
    line-height: 1.75;
  }
  .legal-document li p { text-indent: 0; }
  .legal-document blockquote {
    margin: 3pt 0;
    padding: 0;
    border: 0;
    color: #000;
  }
  .legal-document hr { display: none; }
  .legal-document table {
    width: 100%;
    margin: 6pt 0;
    border-collapse: collapse;
    font-size: 12pt;
  }
  .legal-document th,
  .legal-document td {
    border: 1px solid #000;
    padding: 4pt 6pt;
    vertical-align: middle;
    text-align: left;
  }
  .legal-document strong { font-weight: 700; }
`

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
          a: ({ children }: ComponentPropsWithoutRef<'a'>): ReactNode =>
            createElement('span', null, children)
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
  const body = renderLegalDocumentMarkdown(options.markdown)
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
  const normalized = xml.replace(/<w:rFonts\b([^>]*?)\/>/g, (_match, attributes: string) => {
    const cleaned = attributes
      .replace(/\s+w:ascii="[^"]*"/g, '')
      .replace(/\s+w:asciiTheme="[^"]*"/g, '')
      .replace(/\s+w:hAnsi="[^"]*"/g, '')
      .replace(/\s+w:hAnsiTheme="[^"]*"/g, '')
      .replace(/\s+w:eastAsia="[^"]*"/g, '')
      .replace(/\s+w:eastAsiaTheme="[^"]*"/g, '')
      .replace(/\s+w:hint="[^"]*"/g, '')
    return `<w:rFonts${cleaned} w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS" w:eastAsia="Arial Unicode MS" w:hint="eastAsia"/>`
  })
  return normalized
    .replace(/\s+w:eastAsia="en-US"/g, ' w:eastAsia="zh-CN"')
    .replace(
    /<w:rPr\/>/g,
    '<w:rPr><w:rFonts w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS" w:eastAsia="Arial Unicode MS" w:hint="eastAsia"/><w:lang w:eastAsia="zh-CN"/></w:rPr>'
    )
}

function setHeadingEastAsianFonts(xml: string): string {
  return xml.replace(
    /(<w:pStyle w:val="Heading1"\/>[\s\S]*?<w:rPr>)([\s\S]*?)(<\/w:rPr>)/g,
    (_match, start: string, middle: string, end: string) => {
      const fonts = '<w:rFonts w:ascii="Arial Unicode MS" w:hAnsi="Arial Unicode MS" w:eastAsia="Arial Unicode MS" w:hint="eastAsia"/>'
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

function normalizeLegalParagraphs(xml: string): string {
  return xml.replace(/<w:p>([\s\S]*?)<\/w:p>/g, (paragraph, content: string) => {
    const text = [...content.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((match) => match[1])
      .join('')
      .trim()
    if (!text) return ''

    const style = content.match(/<w:pStyle w:val="([^"]+)"\/>/)?.[1]
    const isSignature = /^(申请人|具状人|答辩人|上诉人|委托人|律师事务所|某.+律师事务所|经办律师|律师|日期|签署日期|立遗嘱人)[：:：]?/.test(text)
    const isNoIndent = /^(致[：:]|关于[：:]|事由[：:]|案由[：:]|编号[：:]|此致[！!。.]?$)/.test(text)

    let properties = content.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)?.[1] ?? ''
    properties = replaceParagraphProperty(
      properties,
      'w:spacing',
      style === 'Heading1'
        ? '<w:spacing w:before="0" w:after="360" w:line="600" w:lineRule="exact"/>'
        : style === 'Heading2'
          ? '<w:spacing w:before="240" w:after="0" w:line="560" w:lineRule="exact"/>'
          : style === 'Heading3'
            ? '<w:spacing w:before="120" w:after="0" w:line="560" w:lineRule="exact"/>'
            : '<w:spacing w:before="0" w:after="0" w:line="560" w:lineRule="exact"/>'
    )
    properties = replaceParagraphProperty(
      properties,
      'w:ind',
      style || isNoIndent || isSignature ? '<w:ind w:firstLine="0"/>' : '<w:ind w:firstLine="640"/>'
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
}

function normalizeLegalStyles(xml: string): string {
  const sizeByStyle: Record<string, string> = {
    Heading1: '44',
    Heading2: '32',
    Heading3: '32'
  }
  let normalized = xml
  for (const [styleId, size] of Object.entries(sizeByStyle)) {
    const stylePattern = new RegExp(
      `(<w:style\\b[^>]*w:styleId="${styleId}"[^>]*>[\\s\\S]*?<w:rPr>)([\\s\\S]*?)(</w:rPr>[\\s\\S]*?</w:style>)`
    )
    normalized = normalized.replace(stylePattern, (_match, start: string, runProps: string, end: string) => {
      const withoutSize = runProps
        .replace(/<w:sz\b[^>]*\/>/g, '')
        .replace(/<w:szCs\b[^>]*\/>/g, '')
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
      ? normalizeLegalParagraphs(setHeadingEastAsianFonts(setEastAsianFont(original)))
      : path === 'word/styles.xml'
        ? normalizeLegalStyles(setEastAsianFont(original))
        : setEastAsianFont(original)
    if (path === 'word/fontTable.xml' && !normalized.includes('w:name="Arial Unicode MS"')) {
      normalized = normalized.replace(
        '</w:fonts>',
        '<w:font w:name="Arial Unicode MS"><w:charset w:val="86"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font></w:fonts>'
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
    font: 'FangSong',
    fontSize: 32,
    pageSize: { width: 11906, height: 16838 },
    margins: { top: 1587, right: 1417, bottom: 1417, left: 1587, header: 720, footer: 720, gutter: 0 }
  })
  return normalizeLegalDocxFonts(await toBuffer(result))
}
