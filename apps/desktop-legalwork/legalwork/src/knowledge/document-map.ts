import type { HeadingMarker } from './knowledge-structured-chunker.js'
import { parseHeadingMarker } from './knowledge-structured-chunker.js'

/**
 * 紧凑文档地图：从一篇长文档（判决书/合同等）生成一份体积可控、字节稳定的
 * 结构索引（head 预览 + 行号锚点）。用于替代"附件全文注入 prefix"——
 * 地图让模型用 read(offset/limit) 精准分段读，而不是把整篇塞进前缀。
 *
 * 设计约束：
 * - 纯函数（同输入必同输出），保证缓存字节稳定；
 * - 过滤 OCR 页眉/页码噪声行（只影响锚点与预览选择，不修改原文）；
 * - 锚点行号与 read 工具的 offset（1-based 行）直接对齐。
 */

export type DocumentMapSection = {
  /** 1-based 原文件行号，可直接作为 read 的 offset */
  line: number
  /** 结构标题（parseHeadingMarker 命中时），无则 undefined */
  heading?: string
  /** 该锚点后首个非噪声内容行，截断到 previewChars */
  preview: string
  /** 调试用：该行在原文中的字符偏移 */
  charStart: number
}

export type DocumentMap = {
  totalLines: number
  totalChars: number
  /** 第一个非空白且非噪声内容行的行号（跳过扫描页眉垃圾） */
  contentStartLine: number
  /** 从 contentStartLine 起、跳过噪声行的开头预览 */
  headText: string
  /** 结构锚点（≤ maxSections） */
  sections: DocumentMapSection[]
  /** 是否完全无结构化标题（用于引导措辞） */
  noHeadings: boolean
}

export const DEFAULT_MAP_HEAD_CHARS = 1_200
export const DEFAULT_MAP_MAX_SECTIONS = 32
export const DEFAULT_MAP_PREVIEW_CHARS = 50

/** OCR/扫描文档常见的页眉、页码噪声行。只影响地图质量，绝不删除原文。 */
const OCR_NOISE_PATTERNS: RegExp[] = [
  /^\s*第\s*[0-9零一二三四五六七八九十百千万两]+\s*页\s*$/,
  /^\s*第\s*\d+\s*页\s*共\s*\d+\s*页\s*$/,
  /^\s*[-—–]+\s*\d{1,4}\s*[-—–]+\s*$/,
  /^\s*\d{1,4}\s*[/／]\s*\d{1,4}\s*$/,
  /^\s*(?:page|p\.?)\s*\d{1,4}\s*$/i,
  /^\s*\d{1,4}\s*$/
]

export function isOcrNoiseLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  return OCR_NOISE_PATTERNS.some((re) => re.test(trimmed))
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0
}

/** 从 fromIndex 起找第一个非空白且非噪声内容行，截断到 previewChars */
function previewLineAt(
  allLines: readonly string[],
  fromIndex: number,
  previewChars: number
): string {
  for (let i = fromIndex; i < allLines.length; i++) {
    const line = allLines[i].trim()
    if (isBlankLine(line) || isOcrNoiseLine(line)) continue
    return line.slice(0, previewChars)
  }
  return ''
}

export function buildDocumentMap(
  text: string,
  options?: {
    headChars?: number
    maxSections?: number
    previewChars?: number
  }
): DocumentMap {
  const headChars = options?.headChars ?? DEFAULT_MAP_HEAD_CHARS
  const maxSections = options?.maxSections ?? DEFAULT_MAP_MAX_SECTIONS
  const previewChars = options?.previewChars ?? DEFAULT_MAP_PREVIEW_CHARS

  const normalized = text.replace(/\r\n/g, '\n')
  const allLines = normalized.split('\n')
  const totalLines = allLines.length
  const totalChars = normalized.length

  // contentStartLine：第一个非空白且非噪声内容行
  let contentStartLine = 1
  for (let i = 0; i < allLines.length; i++) {
    if (!isBlankLine(allLines[i]) && !isOcrNoiseLine(allLines[i])) {
      contentStartLine = i + 1
      break
    }
  }

  // headText：从 contentStartLine 起拼接，跳过噪声行，受 headChars 预算约束
  //（预算包含行间 '\n'，保证 headText.length ≤ headChars）
  const headParts: string[] = []
  let headBudget = headChars
  for (let i = contentStartLine - 1; i < allLines.length && headBudget > 0; i++) {
    if (isOcrNoiseLine(allLines[i])) continue
    if (headParts.length > 0) headBudget -= 1
    if (headBudget <= 0) break
    const take = allLines[i].slice(0, headBudget)
    if (take) headParts.push(take)
    headBudget -= take.length
  }
  const headText = headParts.join('\n')

  // 结构锚点：parseHeadingMarker 命中的标题行
  const headingAnchors: Array<{ line: number; marker: HeadingMarker; charStart: number }> = []
  let charStart = 0
  for (let i = 0; i < allLines.length; i++) {
    const marker = parseHeadingMarker(allLines[i])
    if (marker) headingAnchors.push({ line: i + 1, marker, charStart })
    charStart += allLines[i].length + 1
  }

  const noHeadings = headingAnchors.length === 0
  const sections: DocumentMapSection[] = []

  /** 判决书关键章节：无论采样密度如何都优先保留（避免等间隔跳步漏掉核心段落） */
  const KEY_HEADINGS = new Set(['本院认为', '判决如下', '裁定如下', '本院查明', '经审理查明', '判决结果', '裁定结果', '裁判理由', '裁判结果'])

  if (noHeadings) {
    // 无结构标题 → 按固定间隔兜底锚点，保证每段可达
    const interval = Math.max(1, Math.ceil(totalLines / maxSections))
    for (let i = contentStartLine - 1; i < allLines.length && sections.length < maxSections; i += interval) {
      const lineNo = i + 1
      const anchorCharStart = allLines.slice(0, i).reduce((acc, l) => acc + l.length + 1, 0)
      sections.push({
        line: lineNo,
        preview: previewLineAt(allLines, i, previewChars),
        charStart: anchorCharStart
      })
    }
  } else {
    const keyAnchors = headingAnchors.filter((a) => KEY_HEADINGS.has(a.marker.label))
    const restAnchors = headingAnchors.filter((a) => !KEY_HEADINGS.has(a.marker.label))
    const picked: typeof headingAnchors = []
    // 关键章节优先，全部保留（受 maxSections 约束）
    for (const anchor of keyAnchors) {
      if (picked.length < maxSections) picked.push(anchor)
    }
    // 剩余容量：等间隔采样其余标题
    const restCapacity = maxSections - picked.length
    if (restCapacity > 0 && restAnchors.length > 0) {
      const step = Math.max(1, Math.ceil(restAnchors.length / restCapacity))
      for (let h = 0; h < restAnchors.length && picked.length < maxSections; h += step) {
        picked.push(restAnchors[h])
      }
      // 兜底保留最后一个锚点（通常是判决主文/结果）
      const last = headingAnchors[headingAnchors.length - 1]
      if (picked.length < maxSections && !picked.includes(last)) picked.push(last)
    }
    picked.sort((a, b) => a.line - b.line)
    for (const { line, marker, charStart: anchorCharStart } of picked) {
      sections.push({
        line,
        heading: marker.label,
        preview: previewLineAt(allLines, line, previewChars),
        charStart: anchorCharStart
      })
    }
  }

  return { totalLines, totalChars, contentStartLine, headText, sections, noHeadings }
}

/** 渲染时对超长标题的截断长度（OCR 编号行可能整行被当成标题） */
export const MAX_MAP_HEADING_CHARS = 40

function truncateLabel(label: string, max: number = MAX_MAP_HEADING_CHARS): string {
  return label.length > max ? `${label.slice(0, max)}…` : label
}

/**
 * 渲染地图为人类可读文本。附件地图指令与 read 工具的 structure 模式共用此格式，
 * 保证锚点语义在两处一致。小文档（全文已全部落在 head 预览内）省略冗余索引。
 */
export function renderDocumentMapText(
  map: DocumentMap,
  fileName?: string,
  totalCharsOverride?: number
): string {
  const lines: string[] = []
  if (fileName) {
    const charInfo = totalCharsOverride != null ? `（${totalCharsOverride} 字符）` : ''
    lines.push(`文件 ${fileName}，共 ${map.totalLines} 行${charInfo}。`)
  }
  lines.push(`正文起点：第 ${map.contentStartLine} 行。`)
  const fullTextIncluded = map.totalChars <= DEFAULT_MAP_HEAD_CHARS
  if (map.headText) {
    lines.push(fullTextIncluded ? '全文：' : '开头预览：')
    lines.push(map.headText.slice(0, DEFAULT_MAP_HEAD_CHARS))
  }
  if (!fullTextIncluded) {
    lines.push(map.noHeadings
      ? '结构索引（全文无结构化标题，按固定间隔取样，[行号] 行首内容）：'
      : '结构索引（[行号] 标题：该段开头）：')
    for (const section of map.sections) {
      const label = section.heading ? `${truncateLabel(section.heading)}：` : ''
      lines.push(`[${section.line}] ${label}${section.preview}`)
    }
  }
  return lines.join('\n')
}
