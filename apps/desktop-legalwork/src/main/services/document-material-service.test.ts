import { beforeEach, describe, expect, it, vi } from 'vitest'

const pdfState = vi.hoisted(() => ({
  text: '',
  error: null as Error | null,
  destroy: vi.fn<() => Promise<void>>(),
  logError: vi.fn()
}))

vi.mock('../logger', () => ({
  logError: pdfState.logError
}))

vi.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText(): Promise<{ text: string }> {
      if (pdfState.error) throw pdfState.error
      return { text: pdfState.text }
    }

    async destroy(): Promise<void> {
      await pdfState.destroy()
    }
  }
}))

import {
  extractDocumentMaterial,
  hasUsablePdfTextLayer,
  pdfParserRuntimeFailure
} from './document-material-service'

describe('extractDocumentMaterial PDF routing', () => {
  beforeEach(() => {
    pdfState.text = ''
    pdfState.error = null
    pdfState.destroy.mockReset()
    pdfState.destroy.mockResolvedValue()
    pdfState.logError.mockReset()
  })

  it('returns text-layer content without routing a normal PDF to OCR', async () => {
    pdfState.text = '这是一个带有正常文本层的 PDF。'

    const result = await extractDocumentMaterial({
      fileName: 'normal.pdf',
      dataBase64: Buffer.from('%PDF-test').toString('base64')
    })

    expect(result).toEqual({ ok: true, content: '这是一个带有正常文本层的 PDF。' })
    expect(pdfState.destroy).toHaveBeenCalledOnce()
  })

  it('reports parser failures directly instead of mislabeling them as scanned PDFs', async () => {
    pdfState.error = new Error('broken parser')

    const result = await extractDocumentMaterial({
      fileName: 'normal.pdf',
      dataBase64: Buffer.from('%PDF-test').toString('base64')
    })

    expect(result).toEqual({ ok: false, message: 'PDF 文本解析失败：broken parser' })
    expect(pdfState.destroy).toHaveBeenCalledOnce()
    expect(pdfState.logError).not.toHaveBeenCalled()
  })

  it('reports packaged PDF runtime failures without attachment data', async () => {
    pdfState.error = new ReferenceError('DOMMatrix is not defined')

    const result = await extractDocumentMaterial({
      fileName: '客户秘密合同.pdf',
      dataBase64: Buffer.from('private-pdf-bytes').toString('base64')
    })

    expect(result).toEqual({
      ok: false,
      message: 'PDF 文本解析组件加载失败，请更新或重新安装 Legalwork。'
    })
    expect(pdfState.logError).toHaveBeenCalledWith(
      'document-material-pdf-runtime',
      'PDF text extraction runtime failure: DOMMatrix unavailable'
    )
    expect(JSON.stringify(pdfState.logError.mock.calls)).not.toContain('客户秘密合同')
    expect(JSON.stringify(pdfState.logError.mock.calls)).not.toContain('private-pdf-bytes')
  })
})

describe('pdfParserRuntimeFailure', () => {
  it('classifies runtime/architecture faults but not malformed user PDFs', () => {
    expect(pdfParserRuntimeFailure(new Error('DOMMatrix is not defined'))).toBe('DOMMatrix unavailable')
    expect(pdfParserRuntimeFailure(new Error('dlopen: mach-o file, but is an incompatible architecture')))
      .toBe('Canvas native architecture mismatch')
    expect(pdfParserRuntimeFailure(new Error('Invalid PDF structure'))).toBeNull()
  })
})

describe('hasUsablePdfTextLayer', () => {
  it('does not let page numbers or scanner watermarks suppress OCR', () => {
    expect(hasUsablePdfTextLayer('1\n2\n3\n扫描全能王')).toBe(false)
    expect(hasUsablePdfTextLayer('Page 1 of 8\nPage 2 of 8')).toBe(false)
  })

  it('accepts a substantive text layer', () => {
    expect(hasUsablePdfTextLayer('原告张某诉被告李某买卖合同纠纷一案')).toBe(true)
  })
})
