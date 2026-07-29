import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  buildLegalDocumentHtml,
  legalDocumentMarkdownToDocx
} from './legal-document-export-service'

const require = createRequire(import.meta.url)
const JSZip = require('jszip') as {
  loadAsync(data: Buffer): Promise<{
    file(path: string): { async(type: 'string'): Promise<string> } | null
  }>
}

describe('legal document Word export', () => {
  it('renders legal typography without web-article decoration', () => {
    const html = buildLegalDocumentHtml({
      templateId: 'legal-opinion',
      templateName: '法律意见书',
      markdown: '# 法律意见书\n\n致：某公司\n\n## 一、基本事实\n\n这是正文。'
    })
    expect(html).toContain('class="addressee"')
    expect(html).toContain('data-document-archetype="law-firm-opinion"')
    expect(html).toContain('.legal-document hr { display: none; }')
    expect(html).not.toContain('border-bottom')
  })

  it('writes an explicit East Asian font into DOCX OOXML', async () => {
    const buffer = await legalDocumentMarkdownToDocx({
      templateId: 'legal-opinion',
      templateName: '法律意见书',
      markdown: '# 法律意见书\n\n致：某公司\n\n## 一、基本事实\n\n中文正文。'
    })
    const zip = await JSZip.loadAsync(buffer)
    const styles = await zip.file('word/styles.xml')!.async('string')
    const document = await zip.file('word/document.xml')!.async('string')
    expect(styles).toContain('w:eastAsia="Arial Unicode MS"')
    expect(styles).not.toContain('w:eastAsiaTheme=')
    expect(document).toContain('中文正文')
    expect(document).toContain('w:eastAsia="Arial Unicode MS"')
  })
})
