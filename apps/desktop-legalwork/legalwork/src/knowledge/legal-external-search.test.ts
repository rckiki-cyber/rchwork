import { afterEach, describe, expect, it, vi } from 'vitest'
import { plainTextToDocxBuffer } from '../adapters/tool/plain-text-docx.js'
import { legalExternalSearch } from './legal-external-search.js'

const jsonResponse = (data: unknown): Response => ({
  ok: true,
  status: 200,
  json: async () => data
}) as Response

const bufferResponse = (data: Buffer): Response => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
}) as Response

describe('legalExternalSearch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('presents the NPC database as an optional source without browser escalation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ rows: [] }))

    const result = await legalExternalSearch('劳动合同法 第三十八条')

    expect(result.summary).toContain('可选官方法规来源：国家法律法规数据库')
    expect(result.summary).toContain('https://flk.npc.gov.cn')
    expect(result.summary).toContain('仅在用户明确指定、已配置商业库不可用/无结果或存在重大效力冲突时使用')
    expect(result.summary).toContain('不构成必须逐一检索或交叉核验的要求')
    expect(result.summary).not.toContain('建议 web_search 查询')
  })

  it('searches an explicit canonical law title before broad article-keyword candidates', async () => {
    const seenBodies: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (typeof init?.body === 'string') {
        seenBodies.push(JSON.parse(init.body) as Record<string, unknown>)
      }
      return jsonResponse({ rows: [] })
    })

    await legalExternalSearch('请核实民法典第五百八十五条关于违约金调整的现行规则')

    expect(seenBodies).toContainEqual(expect.objectContaining({
      searchRange: 1,
      searchType: 1,
      searchContent: '中华人民共和国民法典'
    }))
  })

  it('returns deduplicated and ranked NPC records with detail metadata', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/flfgDetails')) {
        return jsonResponse({
          code: 200,
          data: {
            bbbs: 'law-1',
            title: '中华人民共和国劳动合同法',
            flxz: '法律',
            zdjgName: '全国人民代表大会常务委员会',
            gbrq: '2012-12-28',
            sxrq: '2013-07-01',
            sxx: 3,
            content: {
              title: '中华人民共和国劳动合同法',
              children: [
                {
                  title: '第四章 劳动合同的解除和终止',
                  children: [{ title: '第三十八条', children: [] }]
                }
              ]
            }
          }
        })
      }
      return jsonResponse({
        rows: [
          {
            bbbs: 'law-1',
            title: '<em>中华人民共和国劳动合同法</em>',
            flxz: '法律',
            zdjgName: '全国人民代表大会常务委员会',
            gbrq: '2012-12-28',
            sxrq: '2013-07-01',
            sxx: 3,
            score: 98
          },
          {
            bbbs: 'law-1',
            title: '<em>中华人民共和国劳动合同法</em>',
            flxz: '法律',
            zdjgName: '全国人民代表大会常务委员会',
            gbrq: '2012-12-28',
            sxrq: '2013-07-01',
            sxx: 3,
            score: 98
          }
        ]
      })
    })

    const result = await legalExternalSearch('《中华人民共和国劳动合同法》第三十八条')

    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.title).toBe('中华人民共和国劳动合同法')
    expect(result.records[0]?.sourceKind).toBe('web')
    expect(result.records[0]?.path).toBe(
      'https://flk.npc.gov.cn/detail?id=law-1&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E5%8A%B3%E5%8A%A8%E5%90%88%E5%90%8C%E6%B3%95'
    )
    expect(result.records[0]?.excerpt).toContain('现行有效')
    expect(result.records[0]?.excerpt).toContain('目录命中：第三十八条')
    expect(result.records[0]?.excerpt).toContain('来源：国家法律法规数据库详情页')
    expect(result.summary).toContain('标题精确 + 标题模糊 + 正文模糊')
    expect(fetchMock).toHaveBeenCalled()
  })

  it('omits stale NPC search rows whose detail endpoint cannot verify the record', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/flfgDetails')) {
        return jsonResponse({ code: 200 })
      }
      return jsonResponse({
        rows: [{
          bbbs: 'stale-law-id',
          title: '中华人民共和国城市房地产管理法',
          flxz: '法律',
          zdjgName: '全国人民代表大会常务委员会',
          gbrq: '2019-08-26',
          sxrq: '2020-01-01',
          sxx: 3
        }]
      })
    })

    const result = await legalExternalSearch('中华人民共和国城市房地产管理法')

    expect(result.records).toHaveLength(0)
    expect(result.summary).toContain('未返回详情接口核验通过的结构化候选')
    expect(result.summary).toContain('不要引用 /index?...')
  })

  it('downloads official DOCX and extracts the requested article text', async () => {
    const docx = plainTextToDocxBuffer([
      '中华人民共和国劳动合同法',
      '第一条 为了完善劳动合同制度，明确劳动合同双方当事人的权利和义务。',
      '第三十八条 用人单位有下列情形之一的，劳动者可以解除劳动合同：',
      '（一）未按照劳动合同约定提供劳动保护或者劳动条件的；',
      '（二）未及时足额支付劳动报酬的。'
    ].join('\n'))

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/flfgDetails')) {
        return jsonResponse({
          code: 200,
          data: {
            bbbs: 'law-1',
            title: '中华人民共和国劳动合同法',
            flxz: '法律',
            zdjgName: '全国人民代表大会常务委员会',
            gbrq: '2012-12-28',
            sxrq: '2013-07-01',
            sxx: 3,
            content: {
              title: '中华人民共和国劳动合同法',
              children: [{ title: '第三十八条', children: [] }]
            }
          }
        })
      }
      if (url.includes('/download/pc')) {
        return jsonResponse({ code: 200, data: { url: 'https://signed.example/law.docx' } })
      }
      if (url === 'https://signed.example/law.docx') {
        return bufferResponse(docx)
      }
      return jsonResponse({
        rows: [
          {
            bbbs: 'law-1',
            title: '中华人民共和国劳动合同法',
            flxz: '法律',
            zdjgName: '全国人民代表大会常务委员会',
            gbrq: '2012-12-28',
            sxrq: '2013-07-01',
            sxx: 3,
            score: 98
          }
        ]
      })
    })

    const result = await legalExternalSearch('劳动合同法 第三十八条')

    expect(result.records[0]?.excerpt).toContain('条文原文(按条号抽取)')
    expect(result.records[0]?.excerpt).toContain('劳动者可以解除劳动合同')
    expect(result.records[0]?.excerpt).toContain('未及时足额支付劳动报酬')
  })
})
