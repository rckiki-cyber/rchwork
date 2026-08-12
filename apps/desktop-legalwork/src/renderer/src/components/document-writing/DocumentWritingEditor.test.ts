import { describe, expect, it } from 'vitest'
import {
  canGenerateDocument,
  getDocumentWordExportSuccessMessage
} from './DocumentWritingEditor'

describe('document-writing generation readiness', () => {
  it('does not claim generation is ready when there is no material, no pasted text, and no filled field', () => {
    expect(canGenerateDocument({
      hasMaterial: false,
      hasPastedText: false,
      hasAnyFieldFilled: false
    })).toBe(false)
  })

  it('allows generation from a loaded material even with no fields filled', () => {
    expect(canGenerateDocument({
      hasMaterial: true,
      hasPastedText: false,
      hasAnyFieldFilled: false
    })).toBe(true)
  })

  it('allows generation from pasted text even with no material and no fields filled', () => {
    expect(canGenerateDocument({
      hasMaterial: false,
      hasPastedText: true,
      hasAnyFieldFilled: false
    })).toBe(true)
  })

  it('allows generation from a filled field even with no material and no pasted text', () => {
    expect(canGenerateDocument({
      hasMaterial: false,
      hasPastedText: false,
      hasAnyFieldFilled: true
    })).toBe(true)
  })

  it('allows generation when material and pasted text are both present', () => {
    expect(canGenerateDocument({
      hasMaterial: true,
      hasPastedText: true,
      hasAnyFieldFilled: false
    })).toBe(true)
  })

  it('shows a normal success message when standard Word formatting was used', () => {
    expect(getDocumentWordExportSuccessMessage({
      formatPreserved: false,
      warning: '该模板未保留原始 DOCX。'
    })).toBe('Word 文档已导出。')
  })
})
