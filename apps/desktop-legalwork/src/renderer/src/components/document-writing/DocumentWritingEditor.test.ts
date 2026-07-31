import { describe, expect, it } from 'vitest'
import { canGenerateDocument } from './DocumentWritingEditor'

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

  it('still requires explicit select fields when the no-material flow uses them', () => {
    expect(canGenerateDocument({
      missingRequiredFieldCount: 1,
      missingExplicitFieldCount: 1,
      missingDocumentSubjectCount: 0,
      loadedMaterialCount: 0
    })).toBe(false)
  })
})
