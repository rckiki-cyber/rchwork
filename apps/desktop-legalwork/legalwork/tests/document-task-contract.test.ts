import { describe, expect, it } from 'vitest'
import {
  documentTaskContract,
  requiredTopicTerms,
  successfullyVerifiedDraft,
  validateDocumentContent
} from '../src/loop/document-task-contract.js'
import { makeToolCallItem, makeToolResultItem } from '../src/domain/item.js'

describe('document task contract', () => {
  const prompt = [
    '请重点研读至少 3 篇 PDF，并执行 OCR。',
    '演示脱敏处理并产出脱敏后的版本。',
    '撰写一份不少于 1200 字的报告：',
    '- 一、问题的提出',
    '- 二、规范体系',
    '- 参考文献（标注来源）',
    '分析 2-3 个典型案例，文件名含「数字行政法体系建构研究报告」。',
    '禁止省略号和占位符。'
  ].join('\n')

  it('extracts the explicit requirements from a multi-stage prompt', () => {
    expect(documentTaskContract(prompt)).toEqual({
      minimumContentCharacters: 1200,
      requiredHeadings: ['一、问题的提出', '二、规范体系', '参考文献'],
      requiredTopicTerms: [],
      minimumCaseCount: 2,
      requiredFilenameFragment: '数字行政法体系建构研究报告',
      forbidPlaceholders: true,
      requiredKnowledgePdfReads: 3,
      requiresDesensitization: true
    })
  })

  it('extracts the research subject for the model prompt but does not hard-reject on topic', () => {
    const routedPrompt = [
      '查一下食药领域犯罪里，宽严相济刑事政策贯彻的案例，越多越好。',
      '当前追问：撰写这篇论文'
    ].join('\n')
    expect(requiredTopicTerms(routedPrompt)).toEqual([
      '食药领域犯罪',
      '宽严相济刑事政策'
    ])

    // Topic adherence is the model's job. A document that covers the subject
    // in different phrasing must not be rejected for a brittle substring miss.
    const contract = documentTaskContract(routedPrompt)
    expect(validateDocumentContent(
      '# 食品安全犯罪的刑法规制研究\n\n只讨论食品安全犯罪的一般刑法规制。',
      contract
    )).toEqual([])
    expect(validateDocumentContent(
      '# 宽严相济刑事政策在食药领域犯罪中的贯彻\n\n本文分析食药领域犯罪。',
      contract
    )).toEqual([])
  })

  it('rejects an incomplete draft and accepts a complete one', () => {
    const contract = documentTaskContract(prompt)
    const incomplete = '# 一、问题的提出\n\n内容待补充……'
    expect(validateDocumentContent(incomplete, contract)).toEqual(expect.arrayContaining([
      expect.stringContaining('1200'),
      expect.stringContaining('二、规范体系'),
      expect.stringContaining('参考文献'),
      expect.stringContaining('2 个典型案例'),
      expect.stringContaining('省略号或占位'),
      expect.stringContaining('脱敏处理')
    ]))

    const complete = [
      '# 一、问题的提出',
      '# 二、规范体系',
      '脱敏策略采用去标识化并保留可核验的主体映射。',
      '典型案例：（2019）鲁13行终415号；（2021）京01行终88号。',
      '正文内容。'.repeat(300),
      '# 参考文献'
    ].join('\n')
    expect(validateDocumentContent(complete, contract)).toEqual([])
  })

  it('does not mix PPT slide titles into the Word heading contract', () => {
    const contract = documentTaskContract([
      '### 阶段五：撰写研究报告（Word）',
      '- 一、问题的提出',
      '- 二、规范分析',
      '- 参考文献',
      '### 阶段六：普法宣传材料制作（PPT）',
      '- 一、算法执法就在身边',
      '- 二、如何维护程序权利'
    ].join('\n'))

    expect(contract.requiredHeadings).toEqual([
      '一、问题的提出',
      '二、规范分析',
      '参考文献'
    ])
  })

  it('tracks Word, derived PDF, and PPT filename requirements separately', () => {
    const contract = documentTaskContract([
      '研究报告生成 Word，文件名含「算法行政研究报告」',
      '同一报告生成 PDF',
      '普法 PPT 生成 .pptx，文件名含「算法行政普法培训」'
    ].join('\n'))

    expect(contract.requiredArtifactFilenameFragments).toEqual({
      docx: '算法行政研究报告',
      pdf: '算法行政研究报告',
      pptx: '算法行政普法培训'
    })
  })

  it('does not preserve a verifier result that explicitly contains zero citations', () => {
    const common = { turnId: 'turn_1', threadId: 'thread_1', callId: 'call_1' }
    const items = [
      makeToolCallItem({
        id: 'call_item',
        ...common,
        toolName: 'knowledge_citation_verify',
        arguments: { draft: '没有正文引用标记的草稿' }
      }),
      makeToolResultItem({
        id: 'result_item',
        ...common,
        toolName: 'knowledge_citation_verify',
        output: {
          verificationPassed: true,
          documentStats: { totalCitations: 0 }
        }
      })
    ]

    expect(successfullyVerifiedDraft(items, 'turn_1')).toBeUndefined()
  })

  it('hard-gates a framework-based literature refresh on structure, source coverage and recency', () => {
    const currentYear = new Date().getUTCFullYear()
    const cutoff = currentYear - 5
    const revisionPrompt = [
      '这个文章文献参考不够，而且参考文献偏老，我知识库和 IMA 知识库都有很多文献，需要补充修正。',
      '请把 Word 能用的论述、案例、规范、文献保留下来，按照这个框架重组论文并生成 Word：',
      '## 一、宽严相济刑事政策的贯彻依据',
      '### （一）宽严相济刑事政策的基本定位',
      '## 二、食药领域犯罪的危害性特征',
      '## 三、食药领域犯罪中宽严相济刑事政策的具体贯彻'
    ].join('\n')
    const contract = documentTaskContract(revisionPrompt)

    expect(contract).toMatchObject({
      requiredHeadings: [
        '一、宽严相济刑事政策的贯彻依据',
        '（一）宽严相济刑事政策的基本定位',
        '二、食药领域犯罪的危害性特征',
        '三、食药领域犯罪中宽严相济刑事政策的具体贯彻'
      ],
      minimumCaseCount: 1,
      minimumReferenceCount: 20,
      recentReferenceCutoffYear: cutoff,
      minimumRecentReferenceCount: 5,
      minimumKnowledgeSourceCount: 5,
      minimumImaReferenceCount: 3,
      requiresLegalNormContent: true
    })

    const incomplete = '# 一、宽严相济刑事政策的贯彻依据\n\n只有泛泛论述。\n# 参考文献'
    expect(validateDocumentContent(incomplete, contract)).toEqual(expect.arrayContaining([
      expect.stringContaining('二、食药领域犯罪的危害性特征'),
      expect.stringContaining('案例'),
      expect.stringContaining('参考文献仅检出 0 条'),
      expect.stringContaining(`${cutoff} 年以来`),
      expect.stringContaining('具体法律规范')
    ]))

    const references = Array.from({ length: 20 }, (_, index) => {
      const year = index < 5 ? currentYear - index : 2010 + (index % 10)
      return `[${index + 1}] 作者${index + 1}. 食药犯罪研究文献${index + 1}[J]. 法学期刊, ${year}.`
    })
    const complete = [
      '# 一、宽严相济刑事政策的贯彻依据',
      '## （一）宽严相济刑事政策的基本定位',
      '# 二、食药领域犯罪的危害性特征',
      '# 三、食药领域犯罪中宽严相济刑事政策的具体贯彻',
      '本文结合《中华人民共和国刑法》第一百四十一条分析规范依据。',
      '典型案例为（2023）京01刑终123号。',
      '# 参考文献',
      ...references
    ].join('\n')
    expect(validateDocumentContent(complete, contract)).toEqual([])
  })
})
