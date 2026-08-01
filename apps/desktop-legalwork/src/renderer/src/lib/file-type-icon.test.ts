import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FileTypeIcon, fileTypeBadgeClass, fileTypeLabel } from './file-type-icon'

describe('fileTypeLabel', () => {
  it('maps common document types to stable labels', () => {
    expect(fileTypeLabel('民事起诉状.docx')).toBe('WORD')
    expect(fileTypeLabel('判决书.pdf')).toBe('PDF')
    expect(fileTypeLabel('台账.xlsx')).toBe('EXCEL')
    expect(fileTypeLabel('演示.pptx')).toBe('PPT')
    expect(fileTypeLabel('访谈.mp3')).toBe('音频')
    expect(fileTypeLabel('备份.zip')).toBe('压缩包')
    expect(fileTypeLabel('截图.png')).toBe('图片')
    expect(fileTypeLabel('traj_综述.jsonl')).toBe('文本')
  })

  it('falls back to the uppercased extension for unknown types', () => {
    expect(fileTypeLabel('材料.epub')).toBe('EPUB')
    expect(fileTypeLabel('无扩展名文件')).toBe('文件')
  })
})

describe('fileTypeBadgeClass', () => {
  it('returns a colorized badge class per label', () => {
    expect(fileTypeBadgeClass('PDF')).toContain('bg-red-50')
    expect(fileTypeBadgeClass('EXCEL')).toContain('bg-emerald-50')
    expect(fileTypeBadgeClass('EPUB')).toContain('bg-slate-50')
  })
})

describe('FileTypeIcon', () => {
  it('renders a per-type icon for known files', () => {
    expect(renderToStaticMarkup(createElement(FileTypeIcon, { name: '判决书.pdf' }))).toContain('text-red-500')
    expect(renderToStaticMarkup(createElement(FileTypeIcon, { name: '台账.xlsx' }))).toContain('text-emerald-500')
    expect(renderToStaticMarkup(createElement(FileTypeIcon, { name: '访谈.mp3' }))).toContain('text-cyan-500')
    expect(renderToStaticMarkup(createElement(FileTypeIcon, { name: 'traj_综述.jsonl' }))).toContain('text-indigo-500')
  })

  it('always renders a generic fallback for unknown or extensionless files', () => {
    expect(renderToStaticMarkup(createElement(FileTypeIcon, { name: '材料.epub' }))).toContain('text-slate-300')
    expect(renderToStaticMarkup(createElement(FileTypeIcon, { name: '无扩展名文件' }))).toContain('text-slate-300')
  })
})
