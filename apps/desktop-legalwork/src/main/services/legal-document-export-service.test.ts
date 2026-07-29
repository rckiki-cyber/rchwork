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

  it('renders GFM tables and preserves link URLs in research exports', () => {
    const html = buildLegalDocumentHtml({
      templateName: '法律调研报告',
      markdown: [
        '## 二、现行法规检索',
        '',
        '| 法规名称 | 条文 | 链接 |',
        '| --- | --- | --- |',
        '| 《中华人民共和国合伙企业法》 | 第2条 | [北大法宝](https://www.pkulaw.com/chl/example.html) |'
      ].join('\n')
    })

    expect(html).toContain('<table>')
    expect(html).toContain('<th>法规名称</th>')
    expect(html).toContain('北大法宝（https://www.pkulaw.com/chl/example.html）')
    expect(html).not.toContain('| --- |')
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

  it('exports Markdown tables as real Word tables', async () => {
    const buffer = await legalDocumentMarkdownToDocx({
      templateName: '法律调研报告',
      markdown: [
        '## 2.1 核心法规条文',
        '',
        '| 法规名称 | 条文 | 核心内容 | 链接 |',
        '| --- | --- | --- | --- |',
        '| 《中华人民共和国合伙企业法》 | 第2条 | 普通合伙人承担无限连带责任 | [北大法宝](https://www.pkulaw.com/chl/example.html) |'
      ].join('\n')
    })

    const zip = await JSZip.loadAsync(buffer)
    const document = await zip.file('word/document.xml')!.async('string')
    expect(document).toContain('<w:tbl>')
    expect(document).toContain('法规名称')
    expect(document).toContain('北大法宝')
    expect(document).toContain('https://www.pkulaw.com/chl/example.html')
    expect(document).not.toContain('| --- |')
  })
})
