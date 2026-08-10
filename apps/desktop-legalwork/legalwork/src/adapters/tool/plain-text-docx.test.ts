import { describe, expect, it } from 'vitest'
import { plainTextToDocxBuffer } from './plain-text-docx.js'

describe('plain-text-docx footnotes', () => {
  it('emits footnotes part and footnote references for GFM footnote syntax', () => {
    const md = [
      '正文声明[^1]',
      '',
      '[^1]: 参见张明楷《刑法学》第八版，第56页。'
    ].join('\n')
    const buf = plainTextToDocxBuffer(md, { title: 't' })
    const latin = buf.toString('latin1')
    // ZIP 条目名与 XML 内容都以明文字节存在
    expect(latin).toContain('word/footnotes.xml')
    expect(latin).toContain('word/_rels/document.xml.rels')
    expect(latin).toContain('footnoteReference')
    expect(latin).toContain('footnotesDocumentXml'.slice(0, 0) + 'footnotes')
  })

  it('keeps plain documents working without footnotes parts', () => {
    const buf = plainTextToDocxBuffer('普通文档\n第二行', { title: 'p' })
    const latin = buf.toString('latin1')
    expect(latin).toContain('word/document.xml')
    expect(latin).not.toContain('word/footnotes.xml')
  })
})
