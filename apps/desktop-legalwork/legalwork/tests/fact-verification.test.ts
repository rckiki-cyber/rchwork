import { describe, expect, it } from 'vitest'
import { makeToolResultItem } from '../src/domain/item.js'
import {
  factVerificationContract,
  factVerificationProgress,
  validateFactVerificationLedger
} from '../src/loop/fact-verification.js'

const result = (
  callId: string,
  toolName: string,
  output: unknown,
  isError = false
) => makeToolResultItem({
  id: `item_${callId}`,
  threadId: 'thread_1',
  turnId: 'turn_1',
  callId,
  toolName,
  output,
  isError
})

describe('fact verification contract', () => {
  it('treats a whole-document fact, norm and news audit as a broad evidence task', () => {
    expect(factVerificationContract(
      '核实下里面提到的事实、规范、新闻什么的，准确性、真实度'
    )).toEqual({
      required: true,
      requiresWebEvidence: true,
      requiresLegalEvidence: true,
      minimumFetchedSources: 3,
      minimumClaims: 5
    })
  })

  it('does not attach a fact-verification gate to inline document drafting', () => {
    expect(factVerificationContract(
      '<inline_document_response>核验法律效力并撰写法律意见书</inline_document_response>'
    )).toMatchObject({
      required: false,
      requiresWebEvidence: false,
      requiresLegalEvidence: false,
      minimumFetchedSources: 0
    })
  })

  it('does not force general web evidence onto the dedicated legal-research workflow', () => {
    expect(factVerificationContract(
      '请对以下法律问题进行多源调研：「醉驾的最新入刑标准」。最终报告必须作为最后一条独立回复。'
    )).toMatchObject({
      required: false,
      requiresWebEvidence: false,
      requiresLegalEvidence: false,
      minimumFetchedSources: 0
    })
  })

  it('does not mistake legal-database guidance without verified records for evidence', () => {
    const contract = factVerificationContract('核验文中的法律规范和现行效力')
    const noRecords = factVerificationProgress([
      result('legal_1', 'knowledge_legal_external_sources', {
        summary: '可选官方法规来源：国家法律法规数据库。请继续检索并核对效力。',
        records: []
      })
    ], 'turn_1', contract)
    expect(noRecords.legalEvidenceSatisfied).toBe(false)

    const verified = factVerificationProgress([
      result('legal_2', 'knowledge_legal_external_sources', {
        records: [{
          title: '中华人民共和国刑法',
          path: 'https://flk.npc.gov.cn/detail?id=law-1',
          excerpt: '制定机关：全国人民代表大会；状态：现行有效；条文原文包含生产、销售、提供假药罪。'
        }]
      })
    ], 'turn_1', contract)
    expect(verified.legalEvidenceSatisfied).toBe(true)
    expect([...verified.legalSourceUrls]).toEqual(['https://flk.npc.gov.cn/detail?id=law-1'])
  })

  it('requires every cited URL to come from an actually read source', () => {
    const claims = [{
      statement: '刑法修正案（十一）调整了假药罪的行为类型',
      verdict: 'verified',
      rationale: '法规正文和权威发布信息能够相互印证该项修改。',
      evidence: [{ title: '官方法规正文', url: 'https://example.test/law' }]
    }]
    expect(validateFactVerificationLedger({ claims }, {
      minimumClaims: 1,
      minimumSources: 1,
      allowedSourceUrls: new Set(['https://example.test/other'])
    })).toEqual({
      ok: false,
      error: '第 1 项引用了未实际读取的来源：https://example.test/law'
    })

    expect(validateFactVerificationLedger({ claims }, {
      minimumClaims: 1,
      minimumSources: 1,
      allowedSourceUrls: new Set(['https://example.test/law'])
    })).toMatchObject({ ok: true, sourceUrls: ['https://example.test/law'] })
  })
})
