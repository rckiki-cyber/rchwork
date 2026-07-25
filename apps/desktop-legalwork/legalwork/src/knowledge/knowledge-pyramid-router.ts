/**
 * Pyramid Knowledge Layer Router
 *
 * Determines which knowledge layer (L1-L5) a user query targets,
 * enabling layer-aware retrieval that first identifies the right
 * abstraction level before searching within it.
 *
 * All functions are pure — no I/O, no side effects.
 */

import type { KnowledgeLayer } from '../contracts/knowledge.js'

/**
 * Layer definitions with stability, description, and role access.
 */
export interface LayerDef {
  layer: KnowledgeLayer
  label: string
  stability: 'high' | 'medium' | 'low'
  description: string
  /** Default user roles that can access this layer */
  roles: string[]
}

export const LAYER_DEFS: LayerDef[] = [
  { layer: 'principle', label: '原则', stability: 'high', description: '不变的设计原则与核心理念', roles: ['architect', 'developer'] },
  { layer: 'architecture', label: '架构', stability: 'high', description: '架构决策与系统设计', roles: ['architect', 'developer'] },
  { layer: 'standard', label: '规范', stability: 'medium', description: '编码规范与标准', roles: ['developer'] },
  { layer: 'implementation', label: '实现', stability: 'low', description: '实现参考与代码模板', roles: ['developer'] },
  { layer: 'experience', label: '经验', stability: 'low', description: '运维经验与复盘', roles: ['developer', 'ops'] },
]

/** Layer label for display */
export const LAYER_LABEL: Record<KnowledgeLayer, string> = {
  principle: 'L1·原则',
  architecture: 'L2·架构',
  standard: 'L3·规范',
  implementation: 'L4·实现',
  experience: 'L5·经验',
}

/** Layer description for context injection */
export const LAYER_DESC: Record<KnowledgeLayer, string> = {
  principle: '不变的设计原则与核心理念（如 SOLID、KISS），变更周期约年',
  architecture: '架构决策、系统设计、模块划分（ADR），变更周期约季度',
  standard: '编码规范、样式标准、约定（如 ESLint 规则），变更周期约月',
  implementation: '实现参考、模板、SDK 用法、配置示例，变更周期约周',
  experience: '经验复盘、运维日志、踩坑记录，变更周期约天',
}

/** Layer numerical order for comparison */
export const LAYER_ORDER: Record<KnowledgeLayer, number> = {
  principle: 1,
  architecture: 2,
  standard: 3,
  implementation: 4,
  experience: 5,
}

/**
 * Query -> Layer detection rules.
 * Each rule has a set of keywords and the targeted layers.
 */
const LAYER_RULES: Array<{
  keywords: string[]
  target: KnowledgeLayer[]
  score: number
}> = [
  // L1 — 原则层
  { keywords: ['为什么', '原则', '理念', '设计哲学', '指导思想', '顶层', 'why', 'principle', 'philosophy'], target: ['principle'], score: 3 },
  // L1/L2 — 概念与架构
  { keywords: ['概念', '架构', '设计', '系统', '模块', '组件', '架构图', '拓扑', 'relationship', '关系', 'overview', '概览', 'architecture', 'design'], target: ['principle', 'architecture'], score: 3 },
  // L2 — 架构决策
  { keywords: ['选型', '决策', '方案对比', 'ADR', 'trade-off', '取舍', '方案'], target: ['architecture'], score: 3 },
  // L2/L3 — 约束与规范
  { keywords: ['规范', '标准', '约定', '规则', '必须', '禁止', '要求', 'standard', 'convention', 'style guide'], target: ['architecture', 'standard'], score: 3 },
  // L3 — 编码规范
  { keywords: ['命名', '格式', 'eslint', 'lint', '格式化', '缩进'], target: ['standard'], score: 3 },
  // L3/L4 — 实现
  { keywords: ['如何', '怎么', '实现', '代码', '编写', '写法', '示例', '例子', 'how to', 'example', 'snippet', '实现方式'], target: ['standard', 'implementation'], score: 3 },
  // L4 — 实现参考
  { keywords: ['template', '模板', '配置', '参数', 'API', '接口', 'SDK', '函数', '方法', 'class', '调用'], target: ['implementation'], score: 3 },
  // L5 — 经验
  { keywords: ['踩坑', '注意', '最佳实践', '经验', '排查', '报错', '错误', '失败', '复盘', '教训', '优化', 'best practice', 'lesson', 'postmortem', '故障', '监控', '告警'], target: ['experience'], score: 3 },
  // L4/L5 — 运维
  { keywords: ['部署', '发布', '回滚', '迁移', '升级', '配置', '环境', 'dev', 'prod', 'staging', 'CI', 'CD', 'pipeline'], target: ['implementation', 'experience'], score: 2 },
]

/**
 * Detect the most relevant knowledge layer for a query.
 * Returns layers sorted by relevance score descending.
 */
export function detectLayer(query: string): KnowledgeLayer[] {
  const lower = query.toLocaleLowerCase()
  const scores = new Map<KnowledgeLayer, number>()

  for (const rule of LAYER_RULES) {
    const matched = rule.keywords.some((kw) => lower.includes(kw))
    if (matched) {
      for (const layer of rule.target) {
        scores.set(layer, (scores.get(layer) ?? 0) + rule.score)
      }
    }
  }

  // Sort by score descending, then by layer order ascending
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || LAYER_ORDER[a[0]] - LAYER_ORDER[b[0]])
    .map(([layer]) => layer)
}

/**
 * Route result: which layers to search, the role, and the strategy description.
 */
export interface RouteResult {
  targetLayers: KnowledgeLayer[]
  /** Primary layer for the query */
  primaryLayer: KnowledgeLayer | undefined
  /** Descriptive label like "实现参考" */
  primaryLabel: string | undefined
  role: string
  strategy: string
}

/**
 * Route a query to determine the optimal search strategy.
 */
export function route(query: string): RouteResult {
  const layers = detectLayer(query)
  const primaryLayer = layers[0]
  const role = primaryLayer ? (LAYER_DEFS.find((d) => d.layer === primaryLayer)?.roles[0] ?? 'developer') : 'developer'
  const primaryLabel = primaryLayer ? LAYER_LABEL[primaryLayer] : undefined

  const strategy = primaryLayer
    ? `主要检索 ${LAYER_LABEL[primaryLayer]}，扩展上下游各一层`
    : '全层检索'

  return { targetLayers: layers, primaryLayer, primaryLabel, role, strategy }
}

/**
 * Infer layer from document metadata (path, category, extension, tags, content).
 * Used during knowledge base sync to auto-classify.
 */
export function inferLayerFromMeta(
  relativePath: string,
  category?: string,
  tags?: string[],
  extension?: string,
  contentPreview?: string
): KnowledgeLayer | undefined {
  const haystack = `${relativePath} ${category ?? ''} ${tags?.join(' ') ?? ''} ${extension ?? ''} ${contentPreview ?? ''}`.toLowerCase()

  // L5 — 经验/复盘
  if (/\b(经验|复盘|postmortem|踩坑|教训|故障|事故|runbook|sop|learned|lesson)\b/.test(haystack)) return 'experience'
  // L1 — 原则/理念
  if (/\b(原则|principle|理念|philosophy|why-we|设计哲学)\b/.test(haystack)) return 'principle'
  // L2 — 架构/设计
  if (/\b(架构|architecture|设计文档|ADR|design|模块|模块划分|系统设计|拓扑)\b/.test(haystack)) return 'architecture'
  // L3 — 规范/标准
  if (/\b(规范|标准|命名|风格|style guide|convention|规则|规则集|eslint|编码)\b/.test(haystack)) return 'standard'
  // L4 — 实现/模板
  if (/\b(实现|代码|示例|template|配置|api|sdk|用法|how-to|quickstart|指南|手册|reference)\b/.test(haystack)) return 'implementation'

  // Extension-based fallback
  if (extension === '.md' || extension === '.markdown') return undefined  // generic markdown, can't determine

  return undefined
}
