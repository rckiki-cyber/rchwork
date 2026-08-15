import { describe, expect, it } from 'vitest'
import {
  buildDocumentMap,
  isOcrNoiseLine,
  renderDocumentMapText,
  DEFAULT_MAP_HEAD_CHARS
} from '../src/knowledge/document-map.js'

const SAMPLE_JUDGMENT = [
  '第 1 页',
  '内某某某某某某某某某某某某某某某院',
  '3',
  '民 事 判 决 书',
  '（2025）内25民终813号',
  '上诉人（原审原告）：河南联洋建筑工程有限公司。',
  '被上诉人（原审被告）：锡林郭勒盟蓝尚宝商贸有限公司。',
  '第 2 页',
  '上诉请求：',
  '一、撤销原判第一项利息。',
  '二、依法判令返还 343, 350 元款项。',
  '事实和理由：',
  '关于利息，双方合同第八条明确约定。',
  '本院认为：',
  '本案争议焦点为利息计算标准。',
  '判决如下：',
  '一、驳回上诉，维持原判。',
  '第 3 页'
].join('\n')

describe('isOcrNoiseLine', () => {
  it('识别常见 OCR 页眉/页码噪声', () => {
    expect(isOcrNoiseLine('第 1 页')).toBe(true)
    expect(isOcrNoiseLine('第 12 页 共 30 页')).toBe(true)
    expect(isOcrNoiseLine('- 2 -')).toBe(true)
    expect(isOcrNoiseLine('—3—')).toBe(true)
    expect(isOcrNoiseLine('5/8')).toBe(true)
    expect(isOcrNoiseLine('page 3')).toBe(true)
    expect(isOcrNoiseLine('7')).toBe(true)
  })
  it('不误伤正常内容行', () => {
    expect(isOcrNoiseLine('民 事 判 决 书')).toBe(false)
    expect(isOcrNoiseLine('判决如下：')).toBe(false)
    expect(isOcrNoiseLine('二、依法判令返还 343, 350 元款项。')).toBe(false)
    expect(isOcrNoiseLine('')).toBe(false)
  })
})

describe('buildDocumentMap', () => {
  it('锚点行号对齐 read offset，preview 非噪声', () => {
    const map = buildDocumentMap(SAMPLE_JUDGMENT)
    expect(map.contentStartLine).toBe(2) // 第 1 行是噪声"第 1 页"，正文起点在第 2 行
    // "本院认为"在第 14 行（1-based）
    const core = map.sections.find((s) => s.heading === '本院认为')
    expect(core).toBeTruthy()
    expect(core!.line).toBe(14)
    expect(core!.preview).toContain('争议焦点')
    // headText 不含噪声行
    expect(map.headText).not.toContain('第 1 页')
    expect(map.headText).not.toContain('第 2 页')
  })

  it('无结构标题时按固定间隔兜底锚点', () => {
    const plain = Array.from({ length: 50 }, (_, i) => `这是第 ${i + 1} 段普通文本。`).join('\n')
    const map = buildDocumentMap(plain)
    expect(map.noHeadings).toBe(true)
    expect(map.sections.length).toBeGreaterThan(0)
    expect(map.sections.length).toBeLessThanOrEqual(32)
    for (const s of map.sections) {
      expect(s.preview).toContain('普通文本')
    }
  })

  it('确定性：同输入两次输出全等', () => {
    const a = buildDocumentMap(SAMPLE_JUDGMENT)
    const b = buildDocumentMap(SAMPLE_JUDGMENT)
    expect(a).toEqual(b)
    expect(renderDocumentMapText(a)).toBe(renderDocumentMapText(b))
  })

  it('体积护栏：地图远小于原文', () => {
    const longText = SAMPLE_JUDGMENT.repeat(200) // ~4.4 万字符（真实判决书量级）
    const map = buildDocumentMap(longText)
    const rendered = renderDocumentMapText(map)
    expect(rendered.length).toBeLessThanOrEqual(4_000)
    expect(rendered.length).toBeLessThan(longText.length / 10)
    expect(map.headText.length).toBeLessThanOrEqual(DEFAULT_MAP_HEAD_CHARS)
  })
})

describe('renderDocumentMapText', () => {
  it('包含文件名与锚点格式', () => {
    // 放大到超过 head 预算，确保索引渲染
    const big = SAMPLE_JUDGMENT.repeat(10)
    const map = buildDocumentMap(big)
    const text = renderDocumentMapText(map, '判决书.txt', big.length)
    expect(text).toContain('文件 判决书.txt')
    expect(text).toContain('正文起点：第 2 行')
    expect(text).toContain('[14] 本院认为')
  })

  it('小文档省略冗余索引，直接给全文', () => {
    const map = buildDocumentMap(SAMPLE_JUDGMENT)
    const text = renderDocumentMapText(map, '判决书.txt', SAMPLE_JUDGMENT.length)
    expect(text).toContain('全文：')
    expect(text).not.toContain('结构索引')
  })
})
