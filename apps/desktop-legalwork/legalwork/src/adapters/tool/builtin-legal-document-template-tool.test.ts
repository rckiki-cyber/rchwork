import { describe, expect, it } from 'vitest'
import { createResolveLegalDocumentTemplateTool } from './builtin-legal-document-template-tool.js'
import {
  EMBEDDED_LEGAL_DOCUMENT_CAUSES,
  EMBEDDED_LEGAL_DOCUMENT_TEMPLATE_COUNT,
  resolveEmbeddedLegalDocumentTemplate
} from '../../templates/embedded-legal-document-templates.js'

describe('embedded legal document templates', () => {
  it('embeds 11 causes with complaint and answer variants', () => {
    expect(EMBEDDED_LEGAL_DOCUMENT_TEMPLATE_COUNT).toBe(22)
    for (const cause of EMBEDDED_LEGAL_DOCUMENT_CAUSES) {
      expect(resolveEmbeddedLegalDocumentTemplate({ documentType: 'complaint', query: cause })).not.toBeNull()
      expect(resolveEmbeddedLegalDocumentTemplate({ documentType: 'answer', query: cause })).not.toBeNull()
    }
  })

  it('selects the specific complaint structure from case context', () => {
    const template = resolveEmbeddedLegalDocumentTemplate({
      documentType: 'complaint',
      query: '请就物业费欠付起草民事起诉状，案由为物业服务合同纠纷'
    })

    expect(template?.name).toBe('民事起诉状（物业服务合同纠纷）')
    expect(template?.content).toContain('被告欠付物业费数额及计算方式')
    expect(template?.content).not.toContain('对物业费有无异议')
  })

  it('selects the answer variant and returns no false generic match', () => {
    const answer = resolveEmbeddedLegalDocumentTemplate({
      documentType: 'answer',
      query: '为证券虚假陈述责任纠纷被告起草答辩状'
    })
    const none = resolveEmbeddedLegalDocumentTemplate({
      documentType: 'complaint',
      query: '起草一份普通侵权纠纷民事起诉状'
    })

    expect(answer?.content).toContain('对虚假陈述的重大性有无异议')
    expect(none).toBeNull()
  })

  it('returns the resolved template through the agent tool', async () => {
    const tool = createResolveLegalDocumentTemplateTool()
    const result = await tool.execute(
      {
        documentType: 'complaint',
        query: '民间借贷纠纷，需要起诉借款人返还本金和利息'
      },
      {} as never
    )

    expect(result.isError).toBeUndefined()
    expect(result.output).toMatchObject({
      matched: true,
      priority: 'embedded-after-user-template',
      template: {
        cause: '民间借贷纠纷',
        documentType: 'complaint'
      }
    })
  })
})
