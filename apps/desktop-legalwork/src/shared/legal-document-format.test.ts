import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_LEGAL_DOCUMENT_FORMAT_IDS,
  getLegalDocumentFormatSpec,
  legalDocumentFormatInstruction
} from './legal-document-format'

describe('legal document format registry', () => {
  it('covers every built-in writing template', () => {
    expect(BUILT_IN_LEGAL_DOCUMENT_FORMAT_IDS).toHaveLength(40)
    for (const id of BUILT_IN_LEGAL_DOCUMENT_FORMAT_IDS) {
      const spec = getLegalDocumentFormatSpec(id, '')
      expect(spec.requiredOrder.length).toBeGreaterThanOrEqual(6)
      expect(spec.numberingRule).not.toBe('')
      expect(spec.closingRule).not.toBe('')
    }
  })

  it('uses document-specific structures instead of a universal pleading outline', () => {
    expect(getLegalDocumentFormatSpec('legal-opinion', '法律意见书').requiredOrder).toContain('结论性意见')
    expect(getLegalDocumentFormatSpec('sales-contract', '买卖合同').requiredOrder).toContain('签署页')
    expect(getLegalDocumentFormatSpec('power-of-attorney', '授权委托书').requiredOrder).toContain('授权期限')
    expect(getLegalDocumentFormatSpec('company-articles', '公司章程').numberingRule).toContain('章—条体系')
  })

  it('explicitly prevents mechanical western numbering in legal opinions', () => {
    const instruction = legalDocumentFormatInstruction('legal-opinion', '法律意见书')
    expect(instruction).toContain('不得把每句话拆成 1—N 列表')
    expect(instruction).toContain('事务所、经办律师及日期')
  })
})
