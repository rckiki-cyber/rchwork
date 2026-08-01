import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canGenerateDocument,
  getDocumentWordExportSuccessMessage
} from './DocumentWritingEditor'

describe('document-writing generation readiness', () => {
  it('does not claim generation is ready when required fields and materials are both absent', () => {
    expect(canGenerateDocument({
      missingRequiredFieldCount: 1,
      missingExplicitFieldCount: 0,
      loadedMaterialCount: 0
    })).toBe(false)
  })

  it('allows the Agent to fill missing text fields from a loaded material', () => {
    expect(canGenerateDocument({
      missingRequiredFieldCount: 3,
      missingExplicitFieldCount: 0,
      missingDocumentSubjectCount: 0,
      loadedMaterialCount: 1
    })).toBe(true)
  })

  it('requires the user to identify the represented party when materials are present', () => {
    expect(canGenerateDocument({
      missingRequiredFieldCount: 3,
      missingExplicitFieldCount: 0,
      missingDocumentSubjectCount: 1,
      loadedMaterialCount: 2
    })).toBe(false)
  })

  it('requires supplementary instructions when materials are present', () => {
    expect(canGenerateDocument({
      missingRequiredFieldCount: 0,
      missingExplicitFieldCount: 0,
      missingDocumentSubjectCount: 0,
      missingInstructionCount: 1,
      loadedMaterialCount: 1
    })).toBe(false)
  })

  it('still requires explicit select fields when the no-material flow uses them', () => {
    expect(canGenerateDocument({
      missingRequiredFieldCount: 1,
      missingExplicitFieldCount: 1,
      missingDocumentSubjectCount: 0,
      loadedMaterialCount: 0
    })).toBe(false)
  })

  it('keeps legal-document list markers close to their text in the preview', () => {
    const css = readFileSync(
      new URL('../../styles/document-writing.css', import.meta.url),
      'utf8'
    )

    expect(css).toMatch(
      /\.legal-document-preview ul,[\s\S]*?padding-left:\s*1\.65em;/
    )
    expect(css).toMatch(
      /\.legal-document-preview li > p\s*\{[\s\S]*?text-indent:\s*0;/
    )
  })

  it('shows a normal success message when standard Word formatting was used', () => {
    expect(getDocumentWordExportSuccessMessage({
      formatPreserved: false,
      warning: '该模板未保留原始 DOCX。'
    })).toBe('Word 文档已导出。')
  })
})
