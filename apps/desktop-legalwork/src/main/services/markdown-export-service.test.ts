import { describe, expect, it, vi } from 'vitest'
import {
  ensureMarkdownExtension,
  exportMarkdownDocument,
  sanitizeMarkdownExportName
} from './markdown-export-service'

describe('markdown export helpers', () => {
  it('sanitizes file names and preserves supported Markdown extensions', () => {
    expect(sanitizeMarkdownExportName('法律调研:"案例"/结论')).toBe('法律调研__案例__结论')
    expect(ensureMarkdownExtension('/tmp/report.md')).toBe('/tmp/report.md')
    expect(ensureMarkdownExtension('/tmp/report.MARKDOWN')).toBe('/tmp/report.MARKDOWN')
    expect(ensureMarkdownExtension('/tmp/report')).toBe('/tmp/report.md')
  })
})

describe('exportMarkdownDocument', () => {
  it('writes the exact Markdown selected by the user', async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePath: '/tmp/法律调研'
    })
    const writeFile = vi.fn().mockResolvedValue(undefined)

    await expect(exportMarkdownDocument(
      {
        markdown: '# 编辑后的报告\n\n正文',
        defaultName: '法律调研:报告'
      },
      { showSaveDialog, writeFile }
    )).resolves.toEqual({
      ok: true,
      path: '/tmp/法律调研.md'
    })

    expect(showSaveDialog).toHaveBeenCalledWith({
      title: '导出 Markdown',
      defaultPath: '法律调研_报告.md',
      filters: [{ name: 'Markdown 文档', extensions: ['md', 'markdown'] }]
    })
    expect(writeFile).toHaveBeenCalledWith(
      '/tmp/法律调研.md',
      '# 编辑后的报告\n\n正文',
      'utf8'
    )
  })

  it('does not write a file after the save dialog is canceled', async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({ canceled: true })
    const writeFile = vi.fn()

    await expect(exportMarkdownDocument(
      { markdown: '# 报告', defaultName: '报告' },
      { showSaveDialog, writeFile }
    )).resolves.toEqual({ ok: false, canceled: true })

    expect(writeFile).not.toHaveBeenCalled()
  })
})
