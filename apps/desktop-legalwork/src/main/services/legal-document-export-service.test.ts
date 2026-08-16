import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  buildLegalDocumentHtml,
  legalDocumentMarkdownToDocx,
  normalizeLegalDocxBuffer,
  normalizeLegalParagraphs,
  prepareLegalDocumentMarkdown
} from './legal-document-export-service'

const require = createRequire(import.meta.url)
const htmlToDocx = require('html-to-docx') as (
  htmlString: string,
  headerHtmlString?: string | null,
  documentOptions?: Record<string, unknown> | null
) => Promise<ArrayBuffer | Blob>
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

  it('recognizes plain-text legal-document headings without markdown markers', () => {
    const markdown = prepareLegalDocumentMarkdown({
      templateName: '法律意见书',
      markdown: [
        '法律意见书',
        '',
        '致：益阳郁沁工程有限公司',
        '',
        '一、基本事实',
        '',
        '（一）合同签署情况',
        '',
        '正文内容。',
        '',
        '【待核实：出具律所】',
        '',
        '律师：【待核实：出具律师】',
        '',
        '日期：【待核实：出具日期】'
      ].join('\n')
    })

    expect(markdown).toContain('# 法律意见书')
    expect(markdown).toContain('## 一、基本事实')
    expect(markdown).toContain('### （一）合同签署情况')
    expect(markdown).toContain('致：益阳郁沁工程有限公司')
    expect(markdown).toContain('正文内容。')
  })

  it('centers the plain-text title and right-aligns the signature block in DOCX', async () => {
    const buffer = await legalDocumentMarkdownToDocx({
      templateId: 'legal-opinion',
      templateName: '法律意见书',
      markdown: [
        '法律意见书',
        '',
        '致：益阳郁沁工程有限公司',
        '',
        '一、基本事实',
        '',
        '（一）合同签署情况',
        '',
        '正文内容。',
        '',
        '【待核实：出具律所】',
        '',
        '律师：【待核实：出具律师】',
        '',
        '日期：【待核实：出具日期】'
      ].join('\n')
    })
    const zip = await JSZip.loadAsync(buffer)
    const document = await zip.file('word/document.xml')!.async('string')
    const paragraphs = [...document.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((match) => match[1])
    const textOf = (paragraph: string): string =>
      [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => match[1]).join('').trim()

    const title = paragraphs.find((paragraph) => textOf(paragraph) === '法律意见书') ?? ''
    expect(title).toContain('<w:pStyle w:val="Heading1"/>')
    expect(title).toContain('<w:jc w:val="center"/>')
    expect(paragraphs.some((paragraph) => textOf(paragraph) === '一、基本事实' && paragraph.includes('<w:pStyle w:val="Heading2"/>'))).toBe(true)
    expect(paragraphs.some((paragraph) => textOf(paragraph) === '（一）合同签署情况' && paragraph.includes('<w:pStyle w:val="Heading3"/>'))).toBe(true)
    for (const signature of ['【待核实：出具律所】', '律师：【待核实：出具律师】', '日期：【待核实：出具日期】']) {
      const paragraph = paragraphs.find((candidate) => textOf(candidate) === signature) ?? ''
      expect(paragraph).toContain('<w:jc w:val="right"/>')
    }
  })

  it('normalizes legacy html-route DOCX output with legal typography', async () => {
    const html = buildLegalDocumentHtml({
      templateName: '法律意见书',
      markdown: '法律意见书\n\n致：某公司\n\n一、基本事实\n\n中文正文。'
    })
    const raw = await htmlToDocx(html, null, {
      title: '法律意见书',
      creator: 'legalwork',
      font: 'SimSun',
      fontSize: 24
    })
    const rawBuffer = Buffer.isBuffer(raw)
      ? raw
      : raw instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(raw))
        : Buffer.from(await (raw as Blob).arrayBuffer())
    const buffer = await normalizeLegalDocxBuffer(rawBuffer)
    const zip = await JSZip.loadAsync(buffer)
    const styles = await zip.file('word/styles.xml')!.async('string')
    const document = await zip.file('word/document.xml')!.async('string')

    expect(styles).toContain('w:eastAsia="宋体"')
    expect(document).toContain('中文正文')
    expect(document).toContain('w:line="360" w:lineRule="auto"')
    expect(document).toContain('w:firstLine="480" w:firstLineChars="200"')
    expect(document).toContain('<w:jc w:val="center"/>')
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
    expect(html).toContain('<a href="https://www.pkulaw.com/chl/example.html">北大法宝</a>')
    expect(html).not.toContain('北大法宝（https://www.pkulaw.com/chl/example.html）')
    expect(html).not.toContain('| --- |')
  })

  it('keeps substantive two-column research tables as real tables', () => {
    const html = buildLegalDocumentHtml({
      templateName: '法律调研报告',
      markdown: [
        '| 法规名称 | 核心内容 |',
        '| --- | --- |',
        '| 行政处罚法 | 规范行政处罚程序 |'
      ].join('\n')
    })

    expect(html).toContain('<table>')
    expect(html).toContain('<th>法规名称</th>')
    expect(html).toContain('<td>规范行政处罚程序</td>')
  })

  it('converts a generated research answer into report-only prose', () => {
    const markdown = prepareLegalDocumentMarkdown({
      templateName: '法律调研报告',
      markdown: [
        '我来为你进行多源调研。现在整合输出调研报告。',
        '',
        '# 多源调研报告：土地出让金返还条款效力',
        '',
        '## 一、研究摘要',
        '',
        '- **核心结论**：该条款原则上无效。',
        '- **制定机关**：国务院',
        '- **效力等级**：行政法规',
        '- **时效性**：现行有效',
        '- [北大法宝链接](https://www.pkulaw.com/chl/example.html)',
        '',
        '### 1.1 法律依据',
        '',
        '| 项目 | 内容 |',
        '| --- | --- |',
        '| 案号 | （2024）某号 |',
        '| 裁判要旨 | 违反强制性规定 |',
        '',
        '如需我继续补充，请告诉我。'
      ].join('\n')
    })

    expect(markdown).toContain('# 多源调研报告：土地出让金返还条款效力')
    expect(markdown).toContain('## 一、研究摘要')
    expect(markdown).toContain('### （一）法律依据')
    expect(markdown).toContain('**核心结论**：该条款原则上无效。')
    expect(markdown).toContain('**案号：** （2024）某号')
    expect(markdown).toContain('[北大法宝链接](https://www.pkulaw.com/chl/example.html)')
    expect(markdown).not.toContain('我来为你')
    expect(markdown).not.toContain('制定机关')
    expect(markdown).not.toContain('效力等级')
    expect(markdown).not.toContain('时效性')
    expect(markdown).not.toContain('| 项目 |')
    expect(markdown).not.toContain('如需我继续')
    expect(markdown).not.toMatch(/^- /m)
  })

  it('keeps research numbering inline instead of creating wide Word list indents', () => {
    const source = [
      '# 法律调研报告',
      '',
      '## 五、学术观点',
      '',
      '1. **第一篇论文**——核心观点。',
      '',
      '1. **第二篇论文**——核心观点。'
    ].join('\n')
    const markdown = prepareLegalDocumentMarkdown({
      templateName: '法律调研报告',
      markdown: source
    })
    const html = buildLegalDocumentHtml({
      templateName: '法律调研报告',
      markdown: source
    })

    expect(markdown).toContain('1、**第一篇论文**')
    expect(markdown).toContain('1、**第二篇论文**')
    expect(html).not.toContain('<ol>')
    expect(html).not.toContain('<li>')
    expect(html).toContain('>1、<strong>第一篇论文</strong>')
  })

  it('normalizes research heading depth to Chinese legal-document numbering', () => {
    const markdown = prepareLegalDocumentMarkdown({
      templateName: '法律调研报告',
      markdown: [
        '# 法律调研报告',
        '',
        '## 4、分析与风险提示',
        '',
        '### （1）定性分析框架',
        '',
        '#### 第一项 核心分水岭',
        '',
        '##### 1. 具体判断标准'
      ].join('\n')
    })

    expect(markdown).toContain('## 一、分析与风险提示')
    expect(markdown).toContain('### （一）定性分析框架')
    expect(markdown).toContain('#### 1、核心分水岭')
    expect(markdown).toContain('##### （1）具体判断标准')
  })

  it('writes the reference-report font and paragraph settings into DOCX OOXML', async () => {
    const buffer = await legalDocumentMarkdownToDocx({
      templateId: 'legal-opinion',
      templateName: '法律意见书',
      markdown: '# 法律意见书\n\n致：某公司\n\n## 一、基本事实\n\n中文正文。'
    })
    const zip = await JSZip.loadAsync(buffer)
    const styles = await zip.file('word/styles.xml')!.async('string')
    const document = await zip.file('word/document.xml')!.async('string')
    expect(styles).toContain('w:eastAsia="宋体"')
    expect(styles).not.toContain('w:eastAsiaTheme=')
    expect(document).toContain('中文正文')
    expect(document).toContain('w:eastAsia="宋体"')
    expect(styles).toContain('w:sz w:val="24"')
    expect(document).toContain('w:line="360" w:lineRule="auto"')
    expect(document).toContain('w:firstLine="480" w:firstLineChars="200"')
    expect(document).toContain('w:top="1440"')
    expect(document).toContain('w:right="1800"')
    expect(document).toContain('w:bottom="1440"')
    expect(document).toContain('w:left="1800"')
    expect(document).toMatch(/<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*<\/w:body>/)
  })

  it('exports multi-column Markdown tables as real Word tables', async () => {
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
    expect(document).not.toContain('https://www.pkulaw.com/chl/example.html')
    expect(document).not.toContain('| --- |')
  })

  it('creates real Word hyperlinks and excludes research-only noise', async () => {
    const buffer = await legalDocumentMarkdownToDocx({
      templateName: '法律调研报告',
      markdown: [
        '我来为你进行多源调研。现在整合输出调研报告。',
        '',
        '# 土地出让金返还条款法律调研',
        '',
        '## 一、法律依据',
        '',
        '- **制定机关**：国务院',
        '- **效力等级**：行政法规',
        '- **时效性**：现行有效',
        '- [北大法宝链接](https://www.pkulaw.com/chl/example.html)',
        '',
        '这是连续的法律分析正文。'
      ].join('\n')
    })

    const zip = await JSZip.loadAsync(buffer)
    const document = await zip.file('word/document.xml')!.async('string')
    const relationships = await zip.file('word/_rels/document.xml.rels')!.async('string')

    expect(document).toContain('<w:hyperlink')
    expect(document).toContain('北大法宝链接')
    expect(document).toContain('这是连续的法律分析正文')
    expect(document).not.toContain('我来为你')
    expect(document).not.toContain('制定机关')
    expect(document).not.toContain('效力等级')
    expect(document).not.toContain('时效性')
    expect(relationships).toContain('Target="https://www.pkulaw.com/chl/example.html"')
    expect(relationships).toContain('TargetMode="External"')
  })

  it('uses a compact hanging indent when OOXML contains a real numbered paragraph', () => {
    const normalized = normalizeLegalParagraphs([
      '<w:document><w:body><w:p><w:pPr>',
      '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>',
      '<w:ind w:left="1440" w:hanging="720"/>',
      '</w:pPr><w:r><w:t>第一项内容</w:t></w:r></w:p></w:body></w:document>'
    ].join(''))

    expect(normalized).toContain('<w:ind w:left="480" w:hanging="360"/>')
    expect(normalized).not.toContain('w:left="1440"')
    expect(normalized).not.toContain('w:firstLine="480"')
  })

  it('preserves attributed paragraphs and structural page-break paragraphs', () => {
    const normalized = normalizeLegalParagraphs([
      '<w:document><w:body>',
      '<w:p w14:paraId="ABC"><w:r><w:t>正文</w:t></w:r></w:p>',
      '<w:p w14:paraId="BREAK"><w:r><w:br w:type="page"/></w:r></w:p>',
      '</w:body></w:document>'
    ].join(''))

    expect(normalized).toContain('<w:p w14:paraId="ABC">')
    expect(normalized).toContain('w:firstLine="480"')
    expect(normalized).toContain('<w:p w14:paraId="BREAK"><w:r><w:br w:type="page"/></w:r></w:p>')
  })
})
