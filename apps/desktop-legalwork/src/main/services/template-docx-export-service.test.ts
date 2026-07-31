import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { legalDocumentMarkdownToDocx } from './legal-document-export-service'
import {
  fillDocxTemplateWithMarkdown,
  markdownToTemplateBlocks
} from './template-docx-export-service'

const require = createRequire(import.meta.url)
const JSZip = require('jszip') as {
  loadAsync(data: Buffer): Promise<{
    file(path: string): { async(type: 'string'): Promise<string> } | null
  }>
}

describe('format-preserving template DOCX export', () => {
  it('converts Markdown into ordered Word text slots', () => {
    expect(markdownToTemplateBlocks([
      '# 法律意见书',
      '',
      '致：某公司',
      '',
      '| 项目 | 内容 |',
      '| --- | --- |',
      '| 结论 | 合规 |'
    ].join('\n'))).toEqual(['法律意见书', '致：某公司', '项目', '内容', '结论', '合规'])
  })

  it('preserves Chinese legal titles written with ASCII angle brackets', () => {
    expect(markdownToTemplateBlocks(
      '《最高人民法院关于适用<中华人民共和国民事诉讼法>的解释》第六十条'
    )).toEqual([
      '《最高人民法院关于适用<中华人民共和国民事诉讼法>的解释》第六十条'
    ])
  })

  it('changes document text while retaining source styles and section geometry', async () => {
    const source = await legalDocumentMarkdownToDocx({
      templateName: '客户模板',
      markdown: '# 原标题\n\n致：原客户\n\n原正文。\n\n律师：原姓名'
    })
    const sourceZip = await JSZip.loadAsync(source)
    const sourceStyles = await sourceZip.file('word/styles.xml')!.async('string')
    const sourceDocument = await sourceZip.file('word/document.xml')!.async('string')
    const sourceSection = sourceDocument.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/)?.[0]

    const result = await fillDocxTemplateWithMarkdown(
      source,
      '# 法律意见书\n\n致：新客户\n\n这是 Agent 撰写的新正文。\n\n律师：张律师'
    )
    const outputZip = await JSZip.loadAsync(result.buffer)
    const outputStyles = await outputZip.file('word/styles.xml')!.async('string')
    const outputDocument = await outputZip.file('word/document.xml')!.async('string')
    const outputSection = outputDocument.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/)?.[0]

    expect(outputStyles).toBe(sourceStyles)
    expect(outputSection).toBe(sourceSection)
    expect(outputDocument).toContain('法律意见书')
    expect(outputDocument).toContain('新客户')
    expect(outputDocument).toContain('这是 Agent 撰写的新正文。')
    expect(outputDocument).not.toContain('原标题')
    expect(result.generatedBlockCount).toBe(4)
    expect(result.sourceSlotCount).toBeGreaterThanOrEqual(4)
  })

  it('leaves already-matching paragraph XML byte-for-byte unchanged', async () => {
    const markdown = '# 标题\n\n致：客户\n\n正文内容。'
    const source = await legalDocumentMarkdownToDocx({
      templateName: '客户模板',
      markdown
    })
    const sourceZip = await JSZip.loadAsync(source)
    const sourceDocument = await sourceZip.file('word/document.xml')!.async('string')

    const result = await fillDocxTemplateWithMarkdown(source, markdown)
    const outputZip = await JSZip.loadAsync(result.buffer)
    const outputDocument = await outputZip.file('word/document.xml')!.async('string')

    expect(outputDocument).toBe(sourceDocument)
  })
})
