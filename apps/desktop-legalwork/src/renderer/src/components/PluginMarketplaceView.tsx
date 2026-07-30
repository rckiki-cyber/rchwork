import type { ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Blocks,
  BookOpenText,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Database,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe2,
  Info,
  LayoutTemplate,
  Loader2,
  MessagesSquare,
  MoreHorizontal,
  Palette,
  Plus,
  PlayCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Settings,
  Upload,
  Workflow,
  Wrench,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  joinFsPath,
  loadPreferredSkillRootId,
  savePreferredSkillRootId,
  type SkillRootId
} from '../lib/skill-root-preference'
import { readBrowserStorageItem, writeBrowserStorageItem } from '../lib/browser-storage'
import { normalizeWorkspaceRoot } from '../lib/workspace-path'
import { getProvider } from '../agent/registry'
import type { SkillListItem } from '@shared/ds-gui-api'
import type {
  CoreRuntimeInfoJson,
  CoreRuntimeToolDiagnosticsJson
} from '../agent/legalwork-contract'
import { useChatStore } from '../store/chat-store'
import { NoticeView, type MarketplaceNotice } from './PluginMarketplaceParts'
import { AstryxSegmentedControl } from './astryx/AstryxSegmentedControl'
import { AssistantMarkdown } from './chat/AssistantMarkdown'
import type { ComposerSkillSelection } from './chat/composer-skill-selection'
import {
  buildMcpMarketplaceOverlay,
  type McpMarketplaceOverlay,
  type McpMarketplaceOverlayStatus
} from './plugin-marketplace-runtime'

type PluginKind = 'mcp' | 'skill'
type PluginFilter = 'all' | 'recommended' | 'installed'
type NoticeTone = 'success' | 'error' | 'info'
type PluginCategory =
  | 'legal'
  | 'data'
  | 'coding'
  | 'frontend'
  | 'browser'
  | 'files'
  | 'research'
  | 'automation'
  | 'communication'
  | 'media'
  | 'documents'
  | 'security'
  | 'productivity'
  | 'system'
  | 'other'

type Notice = MarketplaceNotice

type MarketplaceItem = {
  id: string
  kind: PluginKind
  titleKey?: string
  descriptionKey?: string
  title?: string
  description?: string
  group: 'recommended' | 'personal'
  sourceLabel?: string
  statusTone?: 'default' | 'success' | 'warning' | 'error'
  category?: PluginCategory
  systemManaged?: boolean
  userInstalled?: boolean
  configurable?: boolean
  needsToken?: boolean
  mcpConfig?: (workspaceRoot: string) => JsonRecord
  skillInstructions?: string
  skillRoot?: string
  skillEntryPath?: string
}

type JsonRecord = Record<string, unknown>

type SkillRootOption = {
  id: SkillRootId
  label: string
  path: string
  available: boolean
}

const INSTALLED_STORAGE_KEY = 'legalwork.installedPlugins'
const LEGALWORK_SCHEDULE_MCP_SERVER_ID = 'legalwork_schedule'
const PKULAW_MCP_GROUP_ID = 'pkulaw'
const PKULAW_MCP_ENDPOINTS = [
  { id: 'pkulaw-law-keyword', url: 'https://apim-gateway.pkulaw.com/mcp-law' },
  { id: 'pkulaw-case-keyword', url: 'https://apim-gateway.pkulaw.com/mcp-case' },
  { id: 'pkulaw-law-search', url: 'https://apim-gateway.pkulaw.com/mcp-law-search-service' },
  { id: 'pkulaw-case-semantic-search', url: 'https://apim-gateway.pkulaw.com/mcp-case-search-service' },
  { id: 'pkulaw-law-item-keyword', url: 'https://apim-gateway.pkulaw.com/mcp-fatiao' },
  { id: 'pkulaw-law-recognition', url: 'https://apim-gateway.pkulaw.com/law_recognition' },
  { id: 'pkulaw-case-number-recognition', url: 'https://apim-gateway.pkulaw.com/case_number_recognition' },
  { id: 'pkulaw-citation-validator', url: 'https://apim-gateway.pkulaw.com/pku_citation_validator' },
  { id: 'pkulaw-doc-link', url: 'https://apim-gateway.pkulaw.com/add-doc-link' }
] as const
const PKULAW_MCP_ENDPOINT_IDS = new Set(PKULAW_MCP_ENDPOINTS.map((endpoint) => endpoint.id))
const YUANDIAN_MCP_GROUP_ID = 'yuandian'
const ANYSEARCH_ID = 'anysearch'
const IMA_KB_ID = 'ima-knowledge-base'
type ImaConnectionStatus = 'valid' | 'expired' | 'unverified' | 'network_error' | 'not_configured'
const YUANDIAN_MCP_ENDPOINTS = [
  { id: 'yuandian-law', url: 'https://open.chineselaw.com/mcp/law/stream' },
  { id: 'yuandian-case', url: 'https://open.chineselaw.com/mcp/case/stream' },
  { id: 'yuandian-company', url: 'https://open.chineselaw.com/mcp/company/stream' }
] as const
const YUANDIAN_MCP_ENDPOINT_IDS = new Set(YUANDIAN_MCP_ENDPOINTS.map((endpoint) => endpoint.id))

const CATEGORY_ORDER: PluginCategory[] = [
  'legal',
  'data',
  'coding',
  'frontend',
  'browser',
  'files',
  'documents',
  'research',
  'automation',
  'communication',
  'media',
  'security',
  'productivity',
  'system',
  'other'
]

const CATEGORY_ICONS: Record<PluginCategory, LucideIcon> = {
  legal: BriefcaseBusiness,
  data: Database,
  coding: Code2,
  frontend: LayoutTemplate,
  browser: Globe2,
  files: FolderOpen,
  research: BookOpenText,
  automation: Workflow,
  communication: MessagesSquare,
  media: Palette,
  documents: FileText,
  security: ShieldCheck,
  productivity: Sparkles,
  system: Wrench,
  other: Blocks
}

const CATEGORY_SCORE_RULES: Array<{ category: PluginCategory; pattern: RegExp; weight?: number }> = [
  { category: 'legal', pattern: /\b(law|legal|case|court|contract|pkulaw|yuandian|clause)\b|法律|法规|案例|合同|诉讼|律师|法宝|元典/i, weight: 3 },
  { category: 'data', pattern: /\b(data|dataset|database|sql|excel|sheet|csv|etl|analytics|redact|redaction|desensiti[sz]e|pii|privacy|compliance)\b|数据|脱敏|表格|数据库|隐私|合规/i, weight: 3 },
  { category: 'coding', pattern: /\b(code|coding|review|bug|debug|test|ci|github|git|repo|backend|api|python|typescript|javascript|node|fastapi|prisma|lint)\b|代码|编程|调试|测试|仓库|后端|接口/i, weight: 3 },
  { category: 'frontend', pattern: /\b(frontend|ui|ux|react|vue|svelte|css|html|tailwind|design|figma|framer|gsap|component)\b|前端|界面|设计|组件|交互/i, weight: 3 },
  { category: 'browser', pattern: /\b(browser|chrome|playwright|selenium|web|scrape|crawler|crawl|fetch)\b|浏览器|网页|爬取|抓取/i, weight: 2 },
  { category: 'files', pattern: /\b(file|filesystem|folder|directory|path|workspace|storage)\b|文件|目录|工作区/i, weight: 2 },
  { category: 'documents', pattern: /\b(doc|docs|document|pdf|word|docx|ppt|pptx|markdown|md|ocr|invoice)\b|文档|材料|合同|PDF|发票|简历|简报/i, weight: 2 },
  { category: 'research', pattern: /\b(research|search|academic|paper|scholar|market|news|digest|literature|knowledge|context7)\b|研究|搜索|检索|论文|文献|市场|新闻|知识库/i, weight: 2 },
  { category: 'automation', pattern: /\b(auto|automation|workflow|schedule|cron|task|agent|mcp|runner|pipeline)\b|自动化|工作流|定时|任务|智能体/i, weight: 2 },
  { category: 'communication', pattern: /\b(gmail|mail|email|lark|feishu|discord|slack|social|calendar|im|message|chat)\b|邮箱|邮件|飞书|日历|消息|社交/i, weight: 2 },
  { category: 'media', pattern: /\b(image|video|audio|ffmpeg|photo|poster|banner|animation|animate|three|3d)\b|图片|图像|视频|音频|海报|动画/i, weight: 2 },
  { category: 'security', pattern: /\b(security|secure|audit|harden|secret|token|auth|vulnerability|compliance)\b|安全|审计|加固|密钥|漏洞/i, weight: 2 },
  { category: 'productivity', pattern: /\b(write|writing|blog|copy|note|notion|obsidian|todo|plan|presentation|slides)\b|写作|笔记|博客|计划|演示|效率/i, weight: 1 },
  { category: 'system', pattern: /\b(system|linux|service|runtime|server|mcp|plugin|connector|install|config)\b|系统|服务|运行时|插件|配置|安装/i, weight: 1 }
]

type McpMarketplaceLabels = {
  configured: string
  connected: string
  error: string
  disabled: string
  tokenRequired: string
  tokenRequiredSummary: string
  pkulawTitle: string
  pkulawSummary: (values: {
    total: number
    connected: number
    tools: number
    errors: number
    disabled: number
    lastError: string
  }) => string
  yuandianTitle: string
  yuandianSummary: (values: {
    total: number
    connected: number
    tools: number
    errors: number
    disabled: number
    lastError: string
  }) => string
}

function loadInstalledPlugins(): string[] {
  try {
    const raw = readBrowserStorageItem(INSTALLED_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function saveInstalledPlugins(ids: string[]): void {
  writeBrowserStorageItem(INSTALLED_STORAGE_KEY, JSON.stringify([...new Set(ids)]))
}

function storageKey(kind: PluginKind, id: string): string {
  return `${kind}:${id}`
}

function normalizePluginId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPkulawMcpEndpointId(id: string): boolean {
  return PKULAW_MCP_ENDPOINT_IDS.has(id as typeof PKULAW_MCP_ENDPOINTS[number]['id'])
}

function isYuandianMcpEndpointId(id: string): boolean {
  return YUANDIAN_MCP_ENDPOINT_IDS.has(id as typeof YUANDIAN_MCP_ENDPOINTS[number]['id'])
}

function hasAuthorizationHeader(config: JsonRecord | undefined): boolean {
  const headers = isJsonRecord(config?.headers) ? config.headers : {}
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
}

function authorizationToken(config: JsonRecord | undefined): string {
  const headers = isJsonRecord(config?.headers) ? config.headers : {}
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')
  if (!entry) return ''
  const match = String(entry[1]).match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() ?? ''
}

function authErrorLooksTokenRelated(entries: Array<{ config?: JsonRecord; diagnostic?: JsonRecord }>): boolean {
  return entries.some((entry) => {
    const details = { ...(entry.config ?? {}), ...(entry.diagnostic ?? {}) }
    const lastError = typeof details.lastError === 'string' ? details.lastError : ''
    return /\b(401|403)\b|unauthori[sz]ed|forbidden|token|api key|apikey/i.test(lastError)
  })
}

function parseMcpJsonConfig(content: string): JsonRecord {
  const trimmed = content.trim()
  if (!trimmed) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`MCP config must be JSON: ${message}`)
  }
  if (!isJsonRecord(parsed)) {
    throw new Error('MCP config must be a JSON object.')
  }
  return parsed
}

function buildStdioMcpServer(
  command: string,
  args: string[],
  options: {
    trustScope?: 'workspace' | 'user'
    trustedWorkspaceRoots?: string[]
    env?: JsonRecord
    timeoutMs?: number
  } = {}
): JsonRecord {
  const trustScope = options.trustScope ?? 'user'
  return {
    enabled: true,
    transport: 'stdio',
    command,
    args,
    env: options.env ?? {},
    trustScope,
    ...(trustScope === 'workspace'
      ? {
          trustedWorkspaceRoots: options.trustedWorkspaceRoots?.length
            ? options.trustedWorkspaceRoots
            : ['/path/to/workspace']
        }
      : {}),
    timeoutMs: options.timeoutMs ?? 30_000
  }
}

export function buildMcpConfig(
  id: string,
  command: string,
  args: string[],
  options?: Parameters<typeof buildStdioMcpServer>[2]
): JsonRecord {
  return {
    servers: {
      [id]: buildStdioMcpServer(command, args, options)
    }
  }
}

export function buildFlintChartMcpConfig(): JsonRecord {
  return buildMcpConfig(
    'flint-chart',
    'npx',
    [
      '--yes',
      'flint-chart-mcp@0.3.0',
      '--transport',
      'stdio',
      '--disable-file-reference'
    ],
    {
      trustScope: 'user',
      timeoutMs: 180_000
    }
  )
}

export function buildPkulawMcpConfig(token: string): JsonRecord {
  const normalizedToken = token.trim()
  const servers: JsonRecord = {}
  for (const { id, url } of PKULAW_MCP_ENDPOINTS) {
    servers[id] = {
      enabled: true,
      transport: 'streamable-http',
      url,
      headers: normalizedToken ? { Authorization: `Bearer ${normalizedToken}` } : {},
      trustScope: 'user',
      timeoutMs: 30000
    }
  }
  return { servers }
}

function buildImaMcpConfig(_workspaceRoot: string, _apiKey: string): JsonRecord {
  return { servers: {} }
}

function buildAnysearchMcpConfig(apiKey: string): JsonRecord {
  const headers: JsonRecord = apiKey.trim()
    ? { Authorization: `Bearer ${apiKey.trim()}` }
    : {}
  const servers: JsonRecord = {}
  servers[ANYSEARCH_ID] = {
    enabled: true,
    transport: 'streamable-http',
    url: 'https://api.anysearch.com/mcp',
    headers,
    trustScope: 'user',
    timeoutMs: 30000
  }
  return { servers }
}

function buildYuandianMcpConfig(apiKey: string): JsonRecord {
  const authorization = `Bearer ${apiKey.trim()}`
  const servers: JsonRecord = {}
  for (const { id, url } of YUANDIAN_MCP_ENDPOINTS) {
    servers[id] = {
      enabled: true,
      transport: 'streamable-http',
      url,
      headers: { Authorization: authorization },
      trustScope: 'user',
      timeoutMs: 30000
    }
  }
  return { servers }
}

function mcpServersFromConfig(config: JsonRecord): JsonRecord {
  if (isJsonRecord(config.servers)) return config.servers
  const capabilities = isJsonRecord(config.capabilities) ? config.capabilities : undefined
  const mcp = isJsonRecord(capabilities?.mcp) ? capabilities.mcp : undefined
  return isJsonRecord(mcp?.servers) ? mcp.servers : {}
}

function mcpServerDescription(server: JsonRecord | undefined, fallback: string): string {
  if (!server) return fallback
  const transport = typeof server.transport === 'string' ? server.transport : ''
  const command = typeof server.command === 'string' ? server.command : ''
  const url = typeof server.url === 'string' ? server.url : ''
  const status = typeof server.status === 'string' ? server.status : ''
  const lastError = typeof server.lastError === 'string' ? server.lastError : ''
  const toolCount = typeof server.toolCount === 'number' && Number.isFinite(server.toolCount)
    ? server.toolCount
    : undefined
  const parts = [
    status ? `status: ${status}` : '',
    transport,
    command || url,
    toolCount != null ? `${toolCount} tools` : '',
    lastError ? `error: ${lastError}` : ''
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : fallback
}

function mcpServerStatus(diagnostic: JsonRecord | undefined, config: JsonRecord | undefined): string {
  const diagnosticStatus = typeof diagnostic?.status === 'string' ? diagnostic.status : ''
  if (diagnosticStatus) return diagnosticStatus
  if (config?.enabled === false || config?.disabled === true) return 'disabled'
  return ''
}

function mcpStatusTone(status: string): MarketplaceItem['statusTone'] {
  if (status === 'connected' || status === 'available') return 'success'
  if (status === 'error' || status === 'unavailable') return 'error'
  if (status === 'disabled') return 'warning'
  return 'default'
}

export function mcpConfigHasServer(content: string, id: string): boolean {
  try {
    const servers = mcpServersFromConfig(parseMcpJsonConfig(content))
    if (id === PKULAW_MCP_GROUP_ID) {
      return Object.keys(servers).some((serverId) => isPkulawMcpEndpointId(serverId))
    }
    if (id === YUANDIAN_MCP_GROUP_ID) {
      return Object.keys(servers).some((serverId) => isYuandianMcpEndpointId(serverId))
    }
    return Object.prototype.hasOwnProperty.call(servers, id)
  } catch {
    return false
  }
}

export function customMcpConfigFragment(id: string, raw: string, fallback: JsonRecord): JsonRecord {
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  const parsed = parseMcpJsonConfig(trimmed)
  if (isJsonRecord(parsed.servers)) return parsed
  if (isJsonRecord(parsed.capabilities)) {
    const mcp = isJsonRecord(parsed.capabilities.mcp) ? parsed.capabilities.mcp : undefined
    if (isJsonRecord(mcp?.servers)) return { servers: mcp.servers }
  }
  if (parsed.command !== undefined || parsed.url !== undefined || parsed.transport !== undefined) {
    return { servers: { [id]: parsed } }
  }
  throw new Error('MCP JSON config must include a servers object or a single server object.')
}

export function mergeMcpJsonConfig(content: string, fragment: JsonRecord): { alreadyExists: boolean; text: string } {
  const current = parseMcpJsonConfig(content)
  const currentServers = mcpServersFromConfig(current)
  const fragmentServers = mcpServersFromConfig(fragment)
  const fragmentServerIds = Object.keys(fragmentServers)
  if (fragmentServerIds.length === 0) {
    throw new Error('MCP JSON config must include at least one server.')
  }
  const alreadyExists = fragmentServerIds.some((id) =>
    Object.prototype.hasOwnProperty.call(currentServers, id)
  )
  if (alreadyExists) {
    return { alreadyExists: true, text: `${JSON.stringify(current, null, 2)}\n` }
  }

  const fragmentRest = { ...fragment }
  delete fragmentRest.servers
  const next = {
    ...current,
    ...fragmentRest,
    servers: {
      ...currentServers,
      ...fragmentServers
    }
  }
  return { alreadyExists: false, text: `${JSON.stringify(next, null, 2)}\n` }
}

export function upsertMcpJsonConfig(
  content: string,
  fragment: JsonRecord,
  options?: { preserveDisabled?: boolean }
): string {
  const current = parseMcpJsonConfig(content)
  const currentServers = mcpServersFromConfig(current)
  const fragmentServers = mcpServersFromConfig(fragment)
  const fragmentServerIds = Object.keys(fragmentServers)
  if (fragmentServerIds.length === 0) {
    throw new Error('MCP JSON config must include at least one server.')
  }
  const nextServers = { ...currentServers }
  for (const serverId of fragmentServerIds) {
    const currentServer = isJsonRecord(nextServers[serverId]) ? nextServers[serverId] : {}
    const fragmentServer = isJsonRecord(fragmentServers[serverId]) ? fragmentServers[serverId] : {}
    nextServers[serverId] = {
      ...currentServer,
      ...fragmentServer,
      enabled: options?.preserveDisabled === false
        ? fragmentServer.enabled
        : currentServer.enabled === false ? false : fragmentServer.enabled
    }
  }
  return `${JSON.stringify({
    ...current,
    servers: nextServers
  }, null, 2)}\n`
}

function buildSkillContent(id: string, title: string, description: string, instructions: string): string {
  return [
    '---',
    `name: ${id}`,
    `description: ${description}`,
    '---',
    '',
    `# ${title}`,
    '',
    instructions
  ].join('\n')
}

function stripSkillFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

function previewMarkdownFromSkillItem(
  item: MarketplaceItem,
  t: (key: string) => string,
  content?: string
): string {
  const existing = stripSkillFrontmatter(content ?? '')
  if (existing) return existing
  if (item.kind !== 'skill') return itemDescription(item, t)
  return stripSkillFrontmatter(buildSkillContent(
    item.id,
    itemTitle(item, t),
    itemDescription(item, t),
    item.skillInstructions ?? itemDescription(item, t)
  ))
}

function itemTitle(item: MarketplaceItem, t: (key: string) => string): string {
  return item.title ?? (item.titleKey ? t(item.titleKey) : item.id)
}

function itemDescription(item: MarketplaceItem, t: (key: string) => string): string {
  return item.description ?? (item.descriptionKey ? t(item.descriptionKey) : '')
}

function marketplaceCategoryLabel(category: PluginCategory, t: (key: string) => string): string {
  return t(`pluginCategory_${category}`)
}

function categoryRank(category: PluginCategory): number {
  const index = CATEGORY_ORDER.indexOf(category)
  return index >= 0 ? index : CATEGORY_ORDER.length
}

function inferCategoryFromText(text: string): PluginCategory {
  const scores = new Map<PluginCategory, number>()
  for (const rule of CATEGORY_SCORE_RULES) {
    const matches = text.match(rule.pattern)
    if (!matches) continue
    scores.set(rule.category, (scores.get(rule.category) ?? 0) + (rule.weight ?? 1))
  }
  let best: PluginCategory = 'other'
  let bestScore = 0
  for (const category of CATEGORY_ORDER) {
    const score = scores.get(category) ?? 0
    if (score > bestScore) {
      best = category
      bestScore = score
    }
  }
  return best
}

export function inferMarketplaceCategory(item: Pick<MarketplaceItem, 'id' | 'kind' | 'title' | 'description' | 'titleKey' | 'descriptionKey' | 'sourceLabel' | 'category'>): PluginCategory {
  if (item.category) return item.category
  const haystack = [
    item.kind,
    item.id,
    item.title,
    item.description,
    item.titleKey,
    item.descriptionKey,
    item.sourceLabel
  ].filter(Boolean).join(' ')
  return inferCategoryFromText(haystack)
}

function sortMarketplaceItems(items: MarketplaceItem[]): MarketplaceItem[] {
  return [...items].sort((left, right) => {
    const categoryDelta = categoryRank(inferMarketplaceCategory(left)) - categoryRank(inferMarketplaceCategory(right))
    if (categoryDelta !== 0) return categoryDelta
    return (left.title ?? left.titleKey ?? left.id).localeCompare(right.title ?? right.titleKey ?? right.id)
  })
}

function groupMarketplaceItemsByCategory(items: MarketplaceItem[]): Array<{ category: PluginCategory; items: MarketplaceItem[] }> {
  const groups = new Map<PluginCategory, MarketplaceItem[]>()
  for (const item of sortMarketplaceItems(items)) {
    const category = inferMarketplaceCategory(item)
    groups.set(category, [...(groups.get(category) ?? []), item])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => categoryRank(left) - categoryRank(right))
    .map(([category, groupedItems]) => ({ category, items: groupedItems }))
}

export function mergeMarketplaceCatalogItems(items: MarketplaceItem[]): MarketplaceItem[] {
  const merged = new Map<string, MarketplaceItem>()
  for (const item of items) {
    const key = storageKey(item.kind, item.id)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, item)
      continue
    }

    const catalogItem = existing.group === 'recommended' ? existing : item.group === 'recommended' ? item : existing
    const discoveredItem = existing.group === 'personal' ? existing : item.group === 'personal' ? item : item
    merged.set(key, {
      ...catalogItem,
      ...discoveredItem,
      title: catalogItem.title ?? discoveredItem.title,
      titleKey: catalogItem.titleKey ?? discoveredItem.titleKey,
      description: discoveredItem.description ?? catalogItem.description,
      descriptionKey: catalogItem.descriptionKey ?? discoveredItem.descriptionKey,
      category: catalogItem.category ?? discoveredItem.category,
      mcpConfig: catalogItem.mcpConfig ?? discoveredItem.mcpConfig,
      systemManaged: catalogItem.systemManaged || discoveredItem.systemManaged,
      configurable: catalogItem.configurable || discoveredItem.configurable
    })
  }
  return sortMarketplaceItems([...merged.values()])
}

export function skillMarketplaceItemsFromDiscoveredSkills(
  skills: SkillListItem[],
  labels: { project: string; global: string; builtin: string; userInstalled: string }
): MarketplaceItem[] {
  return sortMarketplaceItems(skills.map((skill) => ({
    id: skill.id,
    kind: 'skill' as const,
    title: skill.name,
    description: skill.description ?? skill.root,
    group: 'personal' as const,
    skillRoot: skill.root,
    skillEntryPath: skill.entryPath,
    sourceLabel:
      skill.userInstalled ? labels.userInstalled :
      skill.scope === 'builtin' ? labels.builtin :
      skill.scope === 'project' ? labels.project : labels.global,
    systemManaged: skill.scope === 'builtin',
    userInstalled: skill.userInstalled === true,
    category: inferCategoryFromText([
      skill.id,
      skill.name,
      skill.description
    ].filter(Boolean).join(' '))
  })))
}

export function mcpMarketplaceItemsFromConfigAndDiagnostics(
  configText: string,
  diagnostics: CoreRuntimeToolDiagnosticsJson | null,
  labels: McpMarketplaceLabels
): MarketplaceItem[] {
  const servers = new Map<string, {
    id: string
    config?: JsonRecord
    diagnostic?: JsonRecord
  }>()
  try {
    const configServers = mcpServersFromConfig(parseMcpJsonConfig(configText))
    for (const [id, value] of Object.entries(configServers)) {
      if (!id.trim()) continue
      servers.set(id, {
        id,
        config: isJsonRecord(value) ? value : {}
      })
    }
  } catch {
    /* Invalid config is surfaced elsewhere; keep the marketplace render resilient. */
  }
  for (const diagnostic of diagnostics?.mcpServers ?? []) {
    const id = typeof diagnostic.id === 'string' ? diagnostic.id.trim() : ''
    if (!id) continue
    const existing = servers.get(id)
    servers.set(id, {
      id,
      config: existing?.config,
      diagnostic
    })
  }

  const entries = [...servers.values()]
  const pkulawEntries = entries.filter((entry) => isPkulawMcpEndpointId(entry.id))
  const yuandianEntries = entries.filter((entry) => isYuandianMcpEndpointId(entry.id))
  const normalEntries = entries.filter((entry) =>
    !isPkulawMcpEndpointId(entry.id) && !isYuandianMcpEndpointId(entry.id)
  )
  const items: MarketplaceItem[] = normalEntries.map(({ id, config, diagnostic }) => {
    const status = mcpServerStatus(diagnostic, config)
    const details = { ...(config ?? {}), ...(diagnostic ?? {}) }
    const sourceLabel =
      status === 'connected' || status === 'available' ? labels.connected :
      status === 'error' || status === 'unavailable' ? labels.error :
      status === 'disabled' ? labels.disabled :
      labels.configured
    return {
      id,
      kind: 'mcp' as const,
      title: id,
      description: mcpServerDescription(details, labels.configured),
      group: 'personal' as const,
      sourceLabel,
      statusTone: mcpStatusTone(status),
      category: inferCategoryFromText([
        id,
        details.transport,
        details.command,
        details.url,
        details.status,
        details.lastError
      ].filter((value): value is string => typeof value === 'string').join(' '))
    }
  })
  if (pkulawEntries.length > 0) {
    items.push(pkulawMarketplaceItem(pkulawEntries, labels))
  }
  if (yuandianEntries.length > 0) {
    items.push(yuandianMarketplaceItem(yuandianEntries, labels))
  }
  return items.sort((left, right) => (left.title ?? left.id).localeCompare(right.title ?? right.id))
}

function pkulawMarketplaceItem(
  entries: Array<{
    id: string
    config?: JsonRecord
    diagnostic?: JsonRecord
  }>,
  labels: McpMarketplaceLabels
): MarketplaceItem {
  const statuses = entries.map((entry) => mcpServerStatus(entry.diagnostic, entry.config))
  const errorEntries = entries.filter((entry) => {
    const details = { ...(entry.config ?? {}), ...(entry.diagnostic ?? {}) }
    return mcpServerStatus(entry.diagnostic, entry.config) === 'error' ||
      typeof details.lastError === 'string'
  })
  const connected = statuses.filter((status) => status === 'connected' || status === 'available').length
  const disabled = statuses.filter((status) => status === 'disabled').length
  const tools = entries.reduce((sum, entry) => {
    const count = typeof entry.diagnostic?.toolCount === 'number'
      ? entry.diagnostic.toolCount
      : typeof entry.config?.toolCount === 'number'
        ? entry.config.toolCount
        : 0
    return Number.isFinite(count) ? sum + count : sum
  }, 0)
  const lastError = errorEntries
    .map((entry) => {
      const details = { ...(entry.config ?? {}), ...(entry.diagnostic ?? {}) }
      return typeof details.lastError === 'string' ? details.lastError : ''
    })
    .find(Boolean) ?? ''
  const status =
    errorEntries.length > 0 ? 'error' :
    connected > 0 ? 'connected' :
    disabled === entries.length ? 'disabled' :
    'configured'
  const sourceLabel =
    status === 'connected' ? labels.connected :
    status === 'error' ? labels.error :
    status === 'disabled' ? labels.disabled :
    labels.configured
  return {
    id: PKULAW_MCP_GROUP_ID,
    kind: 'mcp',
    title: labels.pkulawTitle,
    description: labels.pkulawSummary({
      total: entries.length,
      connected,
      tools,
      errors: errorEntries.length,
      disabled,
      lastError
    }),
    group: 'personal',
    category: 'legal',
    configurable: true,
    needsToken: entries.some((entry) => !hasAuthorizationHeader(entry.config)),
    sourceLabel,
    statusTone: mcpStatusTone(status)
  }
}

function yuandianMarketplaceItem(
  entries: Array<{
    id: string
    config?: JsonRecord
    diagnostic?: JsonRecord
  }>,
  labels: McpMarketplaceLabels
): MarketplaceItem {
  const statuses = entries.map((entry) => mcpServerStatus(entry.diagnostic, entry.config))
  const errorEntries = entries.filter((entry) => {
    const details = { ...(entry.config ?? {}), ...(entry.diagnostic ?? {}) }
    return mcpServerStatus(entry.diagnostic, entry.config) === 'error' ||
      typeof details.lastError === 'string'
  })
  const connected = statuses.filter((status) => status === 'connected' || status === 'available').length
  const disabled = statuses.filter((status) => status === 'disabled').length
  const tools = entries.reduce((sum, entry) => {
    const count = typeof entry.diagnostic?.toolCount === 'number'
      ? entry.diagnostic.toolCount
      : typeof entry.config?.toolCount === 'number'
        ? entry.config.toolCount
        : 0
    return Number.isFinite(count) ? sum + count : sum
  }, 0)
  const lastError = errorEntries
    .map((entry) => {
      const details = { ...(entry.config ?? {}), ...(entry.diagnostic ?? {}) }
      return typeof details.lastError === 'string' ? details.lastError : ''
    })
    .find(Boolean) ?? ''
  const status =
    errorEntries.length > 0 ? 'error' :
    connected > 0 ? 'connected' :
    disabled === entries.length ? 'disabled' :
    'configured'
  const needsToken = entries.some((entry) => !hasAuthorizationHeader(entry.config)) ||
    authErrorLooksTokenRelated(entries)
  const sourceLabel =
    needsToken ? labels.tokenRequired :
    status === 'connected' ? labels.connected :
    status === 'error' ? labels.error :
    status === 'disabled' ? labels.disabled :
    labels.configured
  return {
    id: YUANDIAN_MCP_GROUP_ID,
    kind: 'mcp',
    title: labels.yuandianTitle,
    description: needsToken
      ? labels.tokenRequiredSummary
      : labels.yuandianSummary({
          total: entries.length,
          connected,
          tools,
          errors: errorEntries.length,
          disabled,
          lastError
        }),
    group: 'personal',
    category: 'legal',
    configurable: true,
    needsToken,
    sourceLabel,
    statusTone: needsToken ? 'warning' : mcpStatusTone(status)
  }
}

function skillNameLooksValid(raw: string): boolean {
  const value = raw.trim()
  return !!value && value !== '.' && value !== '..' && !/[\\/]/.test(value)
}

const RECOMMENDED_ITEMS: MarketplaceItem[] = [
  {
    id: LEGALWORK_SCHEDULE_MCP_SERVER_ID,
    kind: 'mcp',
    titleKey: 'pluginMcpGuiScheduleTitle',
    descriptionKey: 'pluginMcpGuiScheduleDesc',
    group: 'recommended',
    category: 'automation',
    systemManaged: true
  },
  {
    id: 'filesystem',
    kind: 'mcp',
    titleKey: 'pluginMcpFilesystemTitle',
    descriptionKey: 'pluginMcpFilesystemDesc',
    group: 'recommended',
    category: 'files',
    mcpConfig: (workspaceRoot) =>
      buildMcpConfig(
        'filesystem',
        'npx',
        ['-y', '@modelcontextprotocol/server-filesystem', workspaceRoot || '/path/to/project'],
        {
          trustScope: 'workspace',
          trustedWorkspaceRoots: [workspaceRoot || '/path/to/project']
        }
      )
  },
  {
    id: 'playwright',
    kind: 'mcp',
    titleKey: 'pluginMcpPlaywrightTitle',
    descriptionKey: 'pluginMcpPlaywrightDesc',
    group: 'recommended',
    category: 'browser',
    mcpConfig: () =>
      buildMcpConfig(
        'playwright',
        'npx',
        ['-y', '@playwright/mcp@latest']
      )
  },
  {
    id: 'github',
    kind: 'mcp',
    titleKey: 'pluginMcpGithubTitle',
    descriptionKey: 'pluginMcpGithubDesc',
    group: 'recommended',
    category: 'coding',
    mcpConfig: () =>
      buildMcpConfig(
        'github',
        'npx',
        ['-y', '@modelcontextprotocol/server-github']
      )
  },
  {
    id: 'context7',
    kind: 'mcp',
    titleKey: 'pluginMcpContext7Title',
    descriptionKey: 'pluginMcpContext7Desc',
    group: 'recommended',
    category: 'research',
    mcpConfig: () =>
      buildMcpConfig(
        'context7',
        'npx',
        ['-y', '@upstash/context7-mcp@latest']
      )
  },
  {
    id: 'flint-chart',
    kind: 'mcp',
    titleKey: 'pluginMcpFlintChartTitle',
    descriptionKey: 'pluginMcpFlintChartDesc',
    group: 'recommended',
    category: 'data',
    mcpConfig: () => buildFlintChartMcpConfig()
  },
  {
    id: 'pkulaw',
    kind: 'mcp',
    titleKey: 'pluginMcpPkulawTitle',
    descriptionKey: 'pluginMcpPkulawDesc',
    group: 'recommended',
    category: 'legal',
    configurable: true
  },
  {
    id: YUANDIAN_MCP_GROUP_ID,
    kind: 'mcp',
    titleKey: 'pluginMcpYuandianTitle',
    descriptionKey: 'pluginMcpYuandianDesc',
    group: 'recommended',
    category: 'legal',
    configurable: true
  },
  {
    id: ANYSEARCH_ID,
    kind: 'mcp',
    titleKey: 'pluginMcpAnysearchTitle',
    descriptionKey: 'pluginMcpAnysearchDesc',
    group: 'recommended',
    category: 'research',
    configurable: true
  },
  {
    id: IMA_KB_ID,
    kind: 'mcp',
    titleKey: 'pluginMcpImaTitle',
    descriptionKey: 'pluginMcpImaDesc',
    group: 'recommended',
    category: 'research',
    configurable: true
  },
  {
    id: 'code-review',
    kind: 'skill',
    titleKey: 'pluginSkillReviewTitle',
    descriptionKey: 'pluginSkillReviewDesc',
    group: 'recommended',
    category: 'coding',
    skillInstructions:
      'Use this skill when reviewing a code change. Prioritize correctness, regressions, security, performance, and missing tests. Lead with concrete findings and file references.'
  },
  {
    id: 'frontend-polish',
    kind: 'skill',
    titleKey: 'pluginSkillFrontendTitle',
    descriptionKey: 'pluginSkillFrontendDesc',
    group: 'recommended',
    category: 'frontend',
    skillInstructions:
      'Use this skill when improving UI. Preserve the product style, check responsive states, avoid generic layouts, and verify the result visually before handing it back.'
  },
  {
    id: 'bug-hunt',
    kind: 'skill',
    titleKey: 'pluginSkillBugTitle',
    descriptionKey: 'pluginSkillBugDesc',
    group: 'recommended',
    category: 'coding',
    skillInstructions:
      'Use this skill when investigating bugs. Reproduce or narrow the symptom, trace the data flow, identify the smallest fix, and add focused verification where possible.'
  },
  {
    id: 'release-notes',
    kind: 'skill',
    titleKey: 'pluginSkillReleaseTitle',
    descriptionKey: 'pluginSkillReleaseDesc',
    group: 'recommended',
    category: 'productivity',
    skillInstructions:
      'Use this skill when preparing release notes. Group user-facing changes by outcome, call out migrations or risks, and keep wording concise and scannable.'
  }
]

export function PluginMarketplaceView({
  onTrySkill
}: {
  onTrySkill?: (skill: ComposerSkillSelection) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const workspaceRoot = normalizeWorkspaceRoot(useChatStore((s) => s.workspaceRoot))
  const [activeKind, setActiveKind] = useState<PluginKind>('mcp')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PluginFilter>('all')
  const [installed, setInstalled] = useState<string[]>(() => loadInstalledPlugins())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customDescription, setCustomDescription] = useState('')
  const [customCommand, setCustomCommand] = useState('')
  const [customArgs, setCustomArgs] = useState('')
  const [customConfig, setCustomConfig] = useState('')
  const [customSkillBody, setCustomSkillBody] = useState('')
  const [skillRootId, setSkillRootId] = useState<SkillRootId>(() => loadPreferredSkillRootId())
  const [mcpConfigText, setMcpConfigText] = useState('')
  const [mcpLoaded, setMcpLoaded] = useState(false)
  const [configuringItemId, setConfiguringItemId] = useState<string | null>(null)
  const [pkulawToken, setPkulawToken] = useState('')
  const [yuandianApiKey, setYuandianApiKey] = useState('')
  const [anysearchApiKey, setAnysearchApiKey] = useState('')
  const [imaLoggedIn, setImaLoggedIn] = useState(false)
  const [imaConnectionStatus, setImaConnectionStatus] = useState<ImaConnectionStatus>('not_configured')
  const [imaStatusMessage, setImaStatusMessage] = useState('')
  const [imaKnowledgeBaseCount, setImaKnowledgeBaseCount] = useState(0)
  const [imaLoggingIn, setImaLoggingIn] = useState(false)
  const [imaReloggingIn, setImaReloggingIn] = useState(false)
  const [runtimeInfo, setRuntimeInfo] = useState<CoreRuntimeInfoJson | null>(null)
  const [toolDiagnostics, setToolDiagnostics] = useState<CoreRuntimeToolDiagnosticsJson | null>(null)
  const [runtimeOverlayLoading, setRuntimeOverlayLoading] = useState(false)
  const [runtimeOverlayError, setRuntimeOverlayError] = useState('')
  const [discoveredSkills, setDiscoveredSkills] = useState<SkillListItem[]>([])
  const [skillListLoading, setSkillListLoading] = useState(false)
  const [skillListError, setSkillListError] = useState('')
  const [previewItem, setPreviewItem] = useState<MarketplaceItem | null>(null)
  const [previewMarkdown, setPreviewMarkdown] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')

  const skillRootOptions = useMemo<SkillRootOption[]>(() => {
    const hasWorkspace = !!workspaceRoot
    return [
      {
        id: 'workspace-agents',
        label: t('pluginSkillRootWorkspaceAgents'),
        path: workspaceRoot ? joinFsPath(workspaceRoot, '.agents/skills') : '',
        available: hasWorkspace
      },
      {
        id: 'workspace-skills',
        label: t('pluginSkillRootWorkspaceSkills'),
        path: workspaceRoot ? joinFsPath(workspaceRoot, 'skills') : '',
        available: hasWorkspace
      },
      {
        id: 'global-agents',
        label: t('pluginSkillRootGlobalAgents'),
        path: '~/.agents/skills',
        available: true
      },
      {
        id: 'global-deepseek',
        label: t('pluginSkillRootGlobalDeepseek'),
        path: '~/.legalwork/skills',
        available: true
      }
    ]
  }, [t, workspaceRoot])

  const selectedSkillRoot =
    skillRootOptions.find((option) => option.id === skillRootId && option.available) ??
    skillRootOptions.find((option) => option.available)

  useEffect(() => {
    const selectedOption = skillRootOptions.find((option) => option.id === skillRootId && option.available)
    if (selectedOption) {
      savePreferredSkillRootId(skillRootId)
      return
    }
    const fallback = skillRootOptions.find((option) => option.available)
    if (fallback && fallback.id !== skillRootId) {
      setSkillRootId(fallback.id)
    }
  }, [skillRootId, skillRootOptions])

  const readMcpConfig = useCallback(async (): Promise<string> => {
    if (typeof window.dsGui?.getDeepseekConfigFile !== 'function') return mcpConfigText
    const file = await window.dsGui.getDeepseekConfigFile()
    setMcpConfigText(file.content)
    setMcpLoaded(true)
    return file.content
  }, [mcpConfigText])

  useEffect(() => {
    if (activeKind !== 'mcp' || mcpLoaded) return
    void readMcpConfig().catch((e) => {
      setNotice({ tone: 'error', message: e instanceof Error ? e.message : String(e) })
    })
  }, [activeKind, mcpLoaded, readMcpConfig])

  const refreshMcpRuntimeOverlay = useCallback(async (): Promise<void> => {
    if (typeof window.dsGui?.runtimeRequest !== 'function') {
      setRuntimeInfo(null)
      setToolDiagnostics(null)
      setRuntimeOverlayError(t('pluginMcpRuntimeUnavailable'))
      return
    }
    const provider = getProvider()
    if (!provider.getRuntimeInfo && !provider.getToolDiagnostics) {
      setRuntimeOverlayError(t('pluginMcpRuntimeUnavailable'))
      return
    }
    setRuntimeOverlayLoading(true)
    setRuntimeOverlayError('')
    try {
      const [runtimeResult, diagnosticsResult] = await Promise.allSettled([
        provider.getRuntimeInfo?.(),
        provider.getToolDiagnostics?.()
      ])
      if (runtimeResult.status === 'fulfilled' && runtimeResult.value) {
        setRuntimeInfo(runtimeResult.value)
      }
      if (diagnosticsResult.status === 'fulfilled' && diagnosticsResult.value) {
        setToolDiagnostics(diagnosticsResult.value)
      }
      const errors = [runtimeResult, diagnosticsResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => runtimeOverlayErrorMessage(result.reason, t('pluginMcpRuntimeUnavailable')))
      if (errors.length > 0) setRuntimeOverlayError(errors[0] ?? t('pluginActionFailed'))
    } finally {
      setRuntimeOverlayLoading(false)
    }
  }, [t])


  const refreshSkillList = useCallback(async (): Promise<void> => {
    if (typeof window.dsGui?.listSkills !== 'function') {
      setDiscoveredSkills([])
      setSkillListError(t('pluginSkillScanUnavailable'))
      return
    }
    setSkillListLoading(true)
    setSkillListError('')
    try {
      const result = await window.dsGui.listSkills(workspaceRoot || undefined)
      if (!result.ok) {
        setDiscoveredSkills([])
        setSkillListError(result.message)
        return
      }
      setDiscoveredSkills(result.skills)
      if (result.validationErrors.length > 0) {
        setSkillListError(result.validationErrors[0]?.message ?? t('pluginSkillScanPartial'))
      }
    } catch (error) {
      setDiscoveredSkills([])
      setSkillListError(error instanceof Error ? error.message : String(error))
    } finally {
      setSkillListLoading(false)
    }
  }, [t, workspaceRoot])

  useEffect(() => {
    if (activeKind !== 'skill') return
    void refreshSkillList()
  }, [activeKind, refreshSkillList])

  useEffect(() => {
    const refreshFromDisk = (): void => {
      if (activeKind === 'mcp') {
        void readMcpConfig().catch(() => undefined)
        void refreshMcpRuntimeOverlay()
        return
      }
      if (activeKind === 'skill') {
        void refreshSkillList()
      }
    }
    window.addEventListener('focus', refreshFromDisk)
    return () => window.removeEventListener('focus', refreshFromDisk)
  }, [activeKind, readMcpConfig, refreshMcpRuntimeOverlay, refreshSkillList])

  useEffect(() => {
    setNotice(null)
    setCustomOpen(false)
    setConfiguringItemId(null)
    setPkulawToken('')
    setYuandianApiKey('')
    setPreviewItem(null)
    setPreviewMarkdown('')
    setPreviewError('')
  }, [activeKind])

  const markInstalled = (key: string): void => {
    setInstalled((prev) => {
      const next = [...new Set([...prev, key])]
      saveInstalledPlugins(next)
      return next
    })
  }

  const discoveredSkillIds = useMemo(
    () => new Set(discoveredSkills.map((skill) => skill.id)),
    [discoveredSkills]
  )
  const discoveredSkillItems = useMemo(
    () => skillMarketplaceItemsFromDiscoveredSkills(discoveredSkills, {
      project: t('pluginSkillSourceProject'),
      global: t('pluginSkillSourceGlobal'),
      builtin: t('pluginSkillSourceBuiltin'),
      userInstalled: t('pluginSkillSourceUserInstalled')
    }),
    [discoveredSkills, t]
  )
  const discoveredMcpItems = useMemo(
    () => mcpMarketplaceItemsFromConfigAndDiagnostics(mcpConfigText, toolDiagnostics, {
      configured: t('pluginMcpSourceConfigured'),
      connected: t('pluginMcpSourceConnected'),
      error: t('pluginMcpSourceError'),
      disabled: t('pluginMcpSourceDisabled'),
      tokenRequired: t('pluginMcpSourceTokenRequired'),
      tokenRequiredSummary: t('pluginMcpTokenRequiredSummary'),
      pkulawTitle: t('pluginMcpPkulawTitle'),
      pkulawSummary: (values) => t('pluginMcpPkulawSummary', values),
      yuandianTitle: t('pluginMcpYuandianTitle'),
      yuandianSummary: (values) => t('pluginMcpYuandianSummary', values)
    }).filter((item) => item.id !== LEGALWORK_SCHEDULE_MCP_SERVER_ID),
    [mcpConfigText, t, toolDiagnostics]
  )
  const discoveredMcpIds = useMemo(
    () => new Set(discoveredMcpItems.map((item) => item.id)),
    [discoveredMcpItems]
  )
  const marketplaceItems = useMemo(
    () => activeKind === 'skill'
      ? [...RECOMMENDED_ITEMS, ...discoveredSkillItems]
      : [...RECOMMENDED_ITEMS, ...discoveredMcpItems],
    [activeKind, discoveredMcpItems, discoveredSkillItems]
  )

  const isInstalled = useCallback((item: Pick<MarketplaceItem, 'kind' | 'id'>): boolean => {
    if ('userInstalled' in item && item.userInstalled) return true
    if ('group' in item && item.group === 'personal') return true
    const catalogItem = RECOMMENDED_ITEMS.find((candidate) => candidate.kind === item.kind && candidate.id === item.id)
    if (catalogItem?.systemManaged) return true
    if (item.kind === 'skill' && discoveredSkillIds.has(item.id)) return true
    if (item.kind === 'mcp' && discoveredMcpIds.has(item.id)) return true
    const key = storageKey(item.kind, item.id)
    if (installed.includes(key)) return true
    return item.kind === 'mcp' && mcpConfigHasServer(mcpConfigText, item.id)
  }, [discoveredMcpIds, discoveredSkillIds, installed, mcpConfigText])

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return marketplaceItems.filter((item) => item.kind === activeKind)
      .filter((item) => {
        const title = itemTitle(item, t).toLowerCase()
        const description = itemDescription(item, t).toLowerCase()
        const source = item.sourceLabel?.toLowerCase() ?? ''
        const category = marketplaceCategoryLabel(inferMarketplaceCategory(item), t).toLowerCase()
        return !normalizedQuery ||
          title.includes(normalizedQuery) ||
          description.includes(normalizedQuery) ||
          category.includes(normalizedQuery) ||
          source.includes(normalizedQuery) ||
          item.id.includes(normalizedQuery)
      })
      .filter((item) => {
        if (filter === 'recommended') return item.group === 'recommended'
        if (filter === 'installed') return isInstalled(item)
        return true
      })
      .sort((left, right) => {
        const categoryDelta = categoryRank(inferMarketplaceCategory(left)) - categoryRank(inferMarketplaceCategory(right))
        if (categoryDelta !== 0) return categoryDelta
        return itemTitle(left, t).localeCompare(itemTitle(right, t))
      })
  }, [activeKind, filter, isInstalled, marketplaceItems, query, t])

  const mcpUninstalledItems = activeKind === 'mcp'
    ? mergeMarketplaceCatalogItems(visibleItems).filter((item) => !item.systemManaged && !isInstalled(item))
    : []
  const mcpInstalledItems = activeKind === 'mcp'
    ? mergeMarketplaceCatalogItems(visibleItems).filter((item) => !item.systemManaged && isInstalled(item))
    : []
  const userInstalledItems = activeKind === 'skill'
    ? visibleItems.filter((item) => item.kind === 'skill' && item.userInstalled)
    : []
  const recommendedItems = visibleItems.filter((item) => !item.systemManaged && !isInstalled(item))
  const personalItems = visibleItems.filter((item) =>
    item.group === 'personal' ||
    (!item.systemManaged && isInstalled(item) && !discoveredSkillIds.has(item.id) && !discoveredMcpIds.has(item.id))
  ).filter((item) => !item.userInstalled)
  const mcpRuntimeOverlay = useMemo(
    () => buildMcpMarketplaceOverlay({
      runtimeInfo,
      toolDiagnostics,
      managedServers: [{ id: LEGALWORK_SCHEDULE_MCP_SERVER_ID, toolCount: 4 }]
    }),
    [runtimeInfo, toolDiagnostics]
  )

  const appendMcpConfig = async (id: string, config: JsonRecord): Promise<void> => {
    const content = mcpLoaded ? mcpConfigText : await readMcpConfig()
    const merged = mergeMcpJsonConfig(content, config)
    if (merged.alreadyExists) {
      markInstalled(storageKey('mcp', id))
      setNotice({ tone: 'info', message: t('pluginAlreadyAdded') })
      return
    }
    const result = await window.dsGui.setDeepseekConfigFile(merged.text)
    setMcpConfigText(merged.text)
    setMcpLoaded(true)
    markInstalled(storageKey('mcp', id))
    setNotice({ tone: 'success', message: t('pluginMcpAdded', { path: result.path }) })
  }

  const upsertMcpConfig = async (
    id: string,
    config: JsonRecord,
    options?: { preserveDisabled?: boolean }
  ): Promise<void> => {
    const content = mcpLoaded ? mcpConfigText : await readMcpConfig()
    const text = upsertMcpJsonConfig(content, config, options)
    const result = await window.dsGui.setDeepseekConfigFile(text)
    setMcpConfigText(text)
    setMcpLoaded(true)
    markInstalled(storageKey('mcp', id))
    setNotice({ tone: 'success', message: t('pluginMcpTokenUpdated', { path: result.path }) })
  }

  const persistImaConnection = async (): Promise<boolean> => {
    const mcpConfig = await window.dsGui.imaGetMcpConfig()
    if ('error' in mcpConfig) {
      setNotice({ tone: 'error', message: String(mcpConfig.error) })
      return false
    }
    await upsertMcpConfig(IMA_KB_ID, mcpConfig as JsonRecord)
    setConfiguringItemId(null)
    setImaLoggedIn(true)
    setNotice({ tone: 'success', message: t('pluginMcpImaConnected') })
    return true
  }

  useEffect(() => {
    if (activeKind !== 'mcp') return
    void refreshMcpRuntimeOverlay()
  }, [activeKind, refreshMcpRuntimeOverlay])

  const readTokenFromConfig = useCallback((url: string): string => {
    if (!mcpConfigText) return ''
    try {
      const config = JSON.parse(mcpConfigText) as JsonRecord
      const servers = isJsonRecord(config.mcpServers ?? config.servers) ? (config.mcpServers ?? config.servers) as JsonRecord : {}
      for (const server of Object.values(servers)) {
        const srv = server as JsonRecord
        if (srv.url === url) {
          const headers = isJsonRecord(srv.headers) ? srv.headers as JsonRecord : {}
          const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')
          if (entry) {
            const match = String(entry[1]).match(/^Bearer\s+(.+)$/i)
            if (match?.[1]) return match[1].trim()
          }
        }
      }
    } catch { /* ignore parse errors */ }
    return ''
  }, [mcpConfigText])

  const addItem = async (item: MarketplaceItem): Promise<void> => {
    if (item.configurable) {
      if (item.id === PKULAW_MCP_GROUP_ID) {
        const existing = readTokenFromConfig(PKULAW_MCP_ENDPOINTS[0].url)
        setPkulawToken(existing)
      } else if (item.id === YUANDIAN_MCP_GROUP_ID) {
        const existing = readTokenFromConfig(YUANDIAN_MCP_ENDPOINTS[0].url)
        setYuandianApiKey(existing)
      } else if (item.id === ANYSEARCH_ID) {
        const existing = readTokenFromConfig('https://api.anysearch.com/mcp')
        setAnysearchApiKey(existing)
      } else if (item.id === IMA_KB_ID) {
        const cfg = await window.dsGui.imaGetConfig().catch(() => ({
          loggedIn: false,
          status: 'network_error' as const,
          message: t('pluginMcpImaStatusNetworkError'),
          knowledgeBaseCount: 0
        }))
        const loggedIn = Boolean(cfg.loggedIn)
        setImaLoggedIn(loggedIn)
        setImaConnectionStatus(cfg.status)
        setImaStatusMessage(cfg.message || '')
        setImaKnowledgeBaseCount(cfg.knowledgeBaseCount)
        if (loggedIn) {
          if (isInstalled(item)) {
            setConfiguringItemId(item.id)
            return
          }
          setBusyId(storageKey(item.kind, item.id))
          setNotice(null)
          try {
            await persistImaConnection()
          } catch (e) {
            setNotice({ tone: 'error', message: e instanceof Error ? e.message : String(e) })
          } finally {
            setBusyId(null)
          }
          return
        }
        setConfiguringItemId(item.id)
        return
      }
      setConfiguringItemId(item.id)
      return
    }
    setBusyId(storageKey(item.kind, item.id))
    setNotice(null)
    try {
      if (item.kind === 'mcp') {
        if (!item.mcpConfig) return
        let installedVersion = ''
        if (item.id === 'flint-chart') {
          if (typeof window.dsGui?.installOptionalMcpPackage !== 'function') {
            setNotice({ tone: 'error', message: t('pluginMcpOptionalInstallerUnavailable') })
            return
          }
          const installedPackage = await window.dsGui.installOptionalMcpPackage('flint-chart')
          if (!installedPackage.ok) {
            setNotice({
              tone: 'error',
              message: t('pluginMcpFlintInstallFailed', { message: installedPackage.message })
            })
            return
          }
          installedVersion = installedPackage.version
        }
        await appendMcpConfig(item.id, item.mcpConfig(workspaceRoot))
        if (installedVersion) {
          setNotice({
            tone: 'success',
            message: t('pluginMcpFlintInstalled', { version: installedVersion })
          })
        }
        return
      }

      if (!selectedSkillRoot?.path) {
        setNotice({ tone: 'error', message: t('pluginSkillRootMissing') })
        return
      }
      if (item.group === 'personal') return
      const title = itemTitle(item, t)
      const description = itemDescription(item, t)
      const content = buildSkillContent(
        item.id,
        title,
        description,
        item.skillInstructions ?? description
      )
      const result = await window.dsGui.saveSkillFile(selectedSkillRoot.path, item.id, content)
      if (!result.ok) {
        setNotice({ tone: 'error', message: result.message })
        return
      }
      markInstalled(storageKey('skill', item.id))
      await refreshSkillList()
      setNotice({ tone: 'success', message: t('pluginSkillAdded', { path: result.path }) })
    } catch (e) {
      setNotice({ tone: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyId(null)
    }
  }

  const addPkulaw = async (): Promise<void> => {
    const token = pkulawToken.trim()
    setBusyId(storageKey('mcp', 'pkulaw'))
    setNotice(null)
    try {
      await upsertMcpConfig('pkulaw', buildPkulawMcpConfig(token), { preserveDisabled: false })
      setConfiguringItemId(null)
      setPkulawToken('')
    } catch (e) {
      setNotice({ tone: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyId(null)
    }
  }

  const addYuandian = async (): Promise<void> => {
    const apiKey = yuandianApiKey.trim()
    if (!apiKey) {
      setNotice({ tone: 'error', message: t('pluginMcpYuandianKeyRequired') })
      return
    }
    setBusyId(storageKey('mcp', YUANDIAN_MCP_GROUP_ID))
    setNotice(null)
    try {
      await upsertMcpConfig(YUANDIAN_MCP_GROUP_ID, buildYuandianMcpConfig(apiKey))
      setConfiguringItemId(null)
      setYuandianApiKey('')
    } catch (e) {
      setNotice({ tone: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyId(null)
    }
  }

  const addAnysearch = async (): Promise<void> => {
    const apiKey = anysearchApiKey.trim()
    setBusyId(storageKey('mcp', ANYSEARCH_ID))
    setNotice(null)
    try {
      await upsertMcpConfig(ANYSEARCH_ID, buildAnysearchMcpConfig(apiKey))
      setConfiguringItemId(null)
      setAnysearchApiKey('')
    } catch (e) {
      setNotice({ tone: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyId(null)
    }
  }

  const addIma = async (): Promise<void> => {
    setImaLoggingIn(true)
    setNotice(null)
    try {
      const status = await window.dsGui.imaGetConfig()
      setImaConnectionStatus(status.status)
      setImaStatusMessage(status.message || '')
      setImaKnowledgeBaseCount(status.knowledgeBaseCount)
      if (!status.loggedIn) {
        const loginResult = status.status === 'expired'
          ? await window.dsGui.imaRelogin()
          : await window.dsGui.imaLogin()
        if (!loginResult.ok) {
          setNotice({ tone: 'error', message: loginResult.message || '登录失败' })
          return
        }
        setImaConnectionStatus('valid')
        setImaStatusMessage('')
      }
      await persistImaConnection()
    } catch (e) {
      setNotice({ tone: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setImaLoggingIn(false)
    }
  }

  const reloginIma = async (): Promise<void> => {
    setImaReloggingIn(true)
    setNotice(null)
    try {
      const loginResult = await window.dsGui.imaRelogin()
      if (!loginResult.ok) {
        setNotice({ tone: 'error', message: loginResult.message || '重新登录失败' })
        return
      }
      setImaLoggedIn(true)
      setImaConnectionStatus('valid')
      setImaStatusMessage('')
      await persistImaConnection()
    } catch (e) {
      setNotice({ tone: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setImaReloggingIn(false)
    }
  }

  const addCustom = async (): Promise<void> => {
    const id = normalizePluginId(customName)
    if (!id) {
      setNotice({ tone: 'error', message: t('pluginCustomNameRequired') })
      return
    }
    const description = customDescription.trim() || t('pluginCustomFallbackDesc')
    setBusyId(`custom:${activeKind}`)
    setNotice(null)
    try {
      if (activeKind === 'mcp') {
        const fallback = buildMcpConfig(
          id,
          customCommand.trim() || 'npx',
          customArgs
            .split('\n')
            .map((arg) => arg.trim())
            .filter(Boolean)
        )
        await appendMcpConfig(id, customMcpConfigFragment(id, customConfig, fallback))
      } else {
        if (!selectedSkillRoot?.path) {
          setNotice({ tone: 'error', message: t('pluginSkillRootMissing') })
          return
        }
        const body = customSkillBody.trim() || t('pluginCustomSkillFallbackBody')
        const content = buildSkillContent(id, customName.trim() || id, description, body)
        const result = await window.dsGui.saveSkillFile(selectedSkillRoot.path, id, content)
        if (!result.ok) {
          setNotice({ tone: 'error', message: result.message })
          return
        }
        markInstalled(storageKey('skill', id))
        await refreshSkillList()
        setNotice({ tone: 'success', message: t('pluginSkillAdded', { path: result.path }) })
      }
      setCustomName('')
      setCustomDescription('')
      setCustomCommand('')
      setCustomArgs('')
      setCustomConfig('')
      setCustomSkillBody('')
      setCustomOpen(false)
    } catch (e) {
      setNotice({ tone: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyId(null)
    }
  }

  const importSkill = async (): Promise<void> => {
    setBusyId('skill:import')
    setNotice(null)
    try {
      const result = await window.dsGui.importSkill()
      if (!result.ok) {
        if (!result.canceled) setNotice({ tone: 'error', message: result.message })
        return
      }
      await refreshSkillList()
      const names = result.installed.map((item) => item.name).join(', ')
      setNotice({
        tone: 'success',
        message: t('pluginSkillImported', {
          count: result.installed.length,
          names: names || result.userSkillRoot
        })
      })
    } catch (e) {
      setNotice({ tone: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusyId(null)
    }
  }

  const openSkillPreview = async (item: MarketplaceItem): Promise<void> => {
    if (item.kind !== 'skill') return
    setPreviewItem(item)
    setPreviewMarkdown(previewMarkdownFromSkillItem(item, t))
    setPreviewError('')
    setPreviewLoading(false)
    if (!item.skillRoot || !item.skillEntryPath || typeof window.dsGui?.readSkillFile !== 'function') return
    setPreviewLoading(true)
    try {
      const result = await window.dsGui.readSkillFile(item.skillRoot, item.skillEntryPath)
      if (!result.ok) {
        setPreviewError(result.message)
        return
      }
      setPreviewMarkdown(previewMarkdownFromSkillItem(item, t, result.content))
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewLoading(false)
    }
  }

  const closeSkillPreview = (): void => {
    setPreviewItem(null)
    setPreviewMarkdown('')
    setPreviewError('')
    setPreviewLoading(false)
  }

  const copySkillPrompt = async (item: MarketplaceItem): Promise<void> => {
    const prompt = `/skill:${item.id} `
    try {
      await navigator.clipboard.writeText(prompt)
      setNotice({ tone: 'success', message: t('pluginSkillTryCopied', { command: prompt }) })
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const trySkill = (item: MarketplaceItem): void => {
    if (!onTrySkill) {
      void copySkillPrompt(item)
      return
    }
    const description = itemDescription(item, t)
    onTrySkill({
      id: item.id,
      name: itemTitle(item, t),
      ...(description ? { description } : {})
    })
    closeSkillPreview()
  }

  const openSkillLocation = async (item: MarketplaceItem): Promise<void> => {
    const rootPath = item.skillRoot || selectedSkillRoot?.path
    if (!rootPath) {
      setNotice({ tone: 'error', message: t('pluginSkillRootMissing') })
      return
    }
    try {
      const result = await window.dsGui.openSkillRoot(rootPath)
      if (!result.ok) setNotice({ tone: 'error', message: result.message ?? t('pluginActionFailed') })
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const renderConfigPanel = (item: MarketplaceItem): ReactNode => {
    if (item.id === 'pkulaw') {
      return (
        <PkulawConfigPanel
          token={pkulawToken}
          onTokenChange={setPkulawToken}
          onAdd={() => void addPkulaw()}
          onCancel={() => {
            setConfiguringItemId(null)
            setPkulawToken('')
          }}
          busy={busyId === storageKey('mcp', 'pkulaw')}
          t={t}
        />
      )
    }
    if (item.id === YUANDIAN_MCP_GROUP_ID) {
      return (
        <YuandianConfigPanel
          apiKey={yuandianApiKey}
          onApiKeyChange={setYuandianApiKey}
          onAdd={() => void addYuandian()}
          onCancel={() => {
            setConfiguringItemId(null)
            setYuandianApiKey('')
          }}
          busy={busyId === storageKey('mcp', YUANDIAN_MCP_GROUP_ID)}
          t={t}
        />
      )
    }
    if (item.id === ANYSEARCH_ID) {
      return (
        <AnysearchConfigPanel
          apiKey={anysearchApiKey}
          onApiKeyChange={setAnysearchApiKey}
          onAdd={() => void addAnysearch()}
          onCancel={() => {
            setConfiguringItemId(null)
            setAnysearchApiKey('')
          }}
          busy={busyId === storageKey('mcp', ANYSEARCH_ID)}
          t={t}
        />
      )
    }
    if (item.id === IMA_KB_ID) {
      return (
        <ImaConfigPanel
          loggedIn={imaLoggedIn}
          status={imaConnectionStatus}
          statusMessage={imaStatusMessage}
          knowledgeBaseCount={imaKnowledgeBaseCount}
          loggingIn={imaLoggingIn}
          reloggingIn={imaReloggingIn}
          onLogin={() => void addIma()}
          onRelogin={() => void reloginIma()}
          onCancel={() => setConfiguringItemId(null)}
          t={t}
        />
      )
    }
    return null
  }

  const openManageTarget = async (): Promise<void> => {
    try {
      if (activeKind === 'mcp') {
        const result = await window.dsGui.openDeepseekConfigDir()
        if (!result.ok) setNotice({ tone: 'error', message: result.message ?? t('pluginActionFailed') })
        return
      }
      if (!selectedSkillRoot?.path) {
        setNotice({ tone: 'error', message: t('pluginSkillRootMissing') })
        return
      }
      const result = await window.dsGui.openSkillRoot(selectedSkillRoot.path)
      if (!result.ok) setNotice({ tone: 'error', message: result.message ?? t('pluginActionFailed') })
    } catch (e) {
      setNotice({ tone: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="ds-no-drag h-full min-h-0 overflow-y-auto px-5 py-6 font-sans md:px-8 lg:px-10">
      <div className="mx-auto max-w-[1120px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
            <AstryxSegmentedControl
              value={activeKind}
              items={[
                { value: 'mcp', label: t('pluginTabMcp') },
                { value: 'skill', label: t('pluginTabSkill') }
              ]}
              onChange={setActiveKind}
              ariaLabel={`${t('pluginTabMcp')} / ${t('pluginTabSkill')}`}
              className="flex flex-row rounded-[10px] border border-[#d2d7de] bg-[#f3f4f6] p-0.5 shadow-none dark:border-white/[0.12] dark:bg-white/[0.06]"
              buttonClassName="inline-flex min-h-[32px] min-w-fit flex-1 items-center justify-center gap-1.5 rounded-[8px] px-3 text-left text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-black/10 dark:focus-visible:ring-white/20"
              indicatorClassName="rounded-[8px] border border-[#d9dde3] bg-white shadow-none dark:border-white/[0.10] dark:bg-white/[0.10]"
              activeClassName="font-semibold text-[#1f2937] dark:text-white"
              inactiveClassName="font-medium text-[#6b7280] hover:text-[#374151] dark:text-white/55 dark:hover:text-white/80"
            />
          <div data-control-hover-root className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void openManageTarget()}
              className="inline-flex min-h-9 items-center gap-2 rounded-[9px] border border-ds-border bg-[var(--ds-card-soft)] px-3 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
            >
              <Settings className="h-4 w-4" strokeWidth={1.75} />
              {t('pluginManage')}
            </button>
            <button
              type="button"
              onClick={() => setCustomOpen((value) => !value)}
              className="inline-flex min-h-9 items-center gap-2 rounded-[9px] bg-[var(--ds-accent)] px-3 text-[13px] font-semibold text-white shadow-[0_3px_10px_color-mix(in_srgb,var(--ds-accent)_18%,transparent)] transition hover:brightness-105"
            >
              <Plus className="h-4 w-4" strokeWidth={1.9} />
              {t('pluginCreate')}
            </button>
          </div>
        </div>

        <div className="mt-8">
          <h1 className="font-display text-[28px] font-semibold tracking-[-0.025em] text-ds-ink">
            {activeKind === 'mcp' ? t('pluginMcpTitle') : t('pluginSkillTitle')}
          </h1>
          <p className="mt-1.5 max-w-2xl text-[14px] leading-6 text-ds-muted">
            {activeKind === 'mcp' ? t('pluginMcpSubtitle') : t('pluginSkillSubtitle')}
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-2 rounded-[var(--lg-radius-selection)] border border-ds-border bg-[var(--ds-card-soft)] p-1.5 shadow-sm md:flex-row md:items-center">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ds-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 w-full rounded-[9px] border border-transparent bg-transparent pl-11 pr-4 text-[14px] text-ds-ink outline-none transition hover:bg-ds-hover/60 focus:border-ds-border focus:bg-[var(--ds-card-soft)] focus:ring-0"
              placeholder={activeKind === 'mcp' ? t('pluginSearchMcp') : t('pluginSearchSkill')}
            />
          </label>
          <label className="relative w-full md:w-[168px]">
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as PluginFilter)}
              className="h-10 w-full appearance-none rounded-[9px] border border-transparent bg-transparent px-4 pr-9 text-[14px] font-medium text-ds-ink outline-none transition hover:bg-ds-hover/60 focus:border-ds-border focus:bg-[var(--ds-card-soft)] focus:ring-0"
            >
              <option value="all">{t('pluginFilterAll')}</option>
              <option value="recommended">{t('pluginFilterRecommended')}</option>
              <option value="installed">{t('pluginFilterInstalled')}</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ds-faint" />
          </label>
        </div>

        {activeKind === 'skill' ? (
          <div data-control-hover-root className="mt-4 flex flex-col gap-2 md:flex-row md:items-center">
            <select
              value={selectedSkillRoot?.id ?? ''}
              onChange={(event) => setSkillRootId(event.target.value as SkillRootId)}
              className="h-10 rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] text-ds-ink shadow-sm outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
            >
              {skillRootOptions.map((option) => (
                <option key={option.id} value={option.id} disabled={!option.available}>
                  {option.available ? option.label : `${option.label} · ${t('pluginSkillRootNeedsWorkspace')}`}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void openManageTarget()}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
            >
              <FolderOpen className="h-4 w-4" />
              {t('pluginOpenLocation')}
            </button>
            <button
              type="button"
              onClick={() => void importSkill()}
              disabled={busyId === 'skill:import'}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-ds-userbubble px-3 text-[13px] font-semibold text-ds-userbubbleFg shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busyId === 'skill:import' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {t('pluginSkillImport')}
            </button>
            <button
              type="button"
              onClick={() => void refreshSkillList()}
              disabled={skillListLoading}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {skillListLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('pluginSkillRefresh')}
            </button>
            {skillListError ? (
              <span className="text-[12px] text-red-700 dark:text-red-300">
                {skillListError}
              </span>
            ) : (
              <span className="text-[12px] text-ds-faint">
                {t('pluginSkillDiscoveredCount', { count: discoveredSkills.length })}
              </span>
            )}
          </div>
        ) : null}

        {activeKind === 'mcp' ? (
          <McpRuntimeOverlayPanel
            overlay={mcpRuntimeOverlay}
            loading={runtimeOverlayLoading}
            error={runtimeOverlayError}
            onRefresh={() => void refreshMcpRuntimeOverlay()}
            t={t}
          />
        ) : null}

        {customOpen ? (
          <CustomPluginPanel
            activeKind={activeKind}
            customName={customName}
            customDescription={customDescription}
            customCommand={customCommand}
            customArgs={customArgs}
            customConfig={customConfig}
            customSkillBody={customSkillBody}
            busy={busyId === `custom:${activeKind}`}
            onNameChange={setCustomName}
            onDescriptionChange={setCustomDescription}
            onCommandChange={setCustomCommand}
            onArgsChange={setCustomArgs}
            onConfigChange={setCustomConfig}
            onSkillBodyChange={setCustomSkillBody}
            onAdd={() => void addCustom()}
          />
        ) : null}

        {notice ? <NoticeView notice={notice} /> : null}

        {activeKind === 'mcp' ? (
          <>
            <PluginSection
              title={t('pluginRecommended')}
              emptyText={t('pluginNoResults')}
              items={mcpUninstalledItems}
              busyId={busyId}
              isInstalled={isInstalled}
              onAdd={addItem}
              onPreview={(item) => void openSkillPreview(item)}
              configuringItemId={configuringItemId}
              renderConfig={renderConfigPanel}
              t={t}
            />
            <PluginSection
              title={t('pluginPersonal')}
              emptyText={t('pluginPersonalEmpty')}
              items={mcpInstalledItems}
              busyId={busyId}
              isInstalled={isInstalled}
              onAdd={addItem}
              onPreview={(item) => void openSkillPreview(item)}
              configuringItemId={configuringItemId}
              renderConfig={renderConfigPanel}
              t={t}
            />
          </>
        ) : null}

        {activeKind === 'skill' ? (
          <PluginSection
            title={t('pluginUserInstalled')}
            emptyText={t('pluginUserInstalledEmpty')}
            items={userInstalledItems}
            busyId={busyId}
            isInstalled={isInstalled}
            onAdd={addItem}
            onPreview={(item) => void openSkillPreview(item)}
            configuringItemId={configuringItemId}
            renderConfig={renderConfigPanel}
            t={t}
          />
        ) : null}

        {activeKind === 'skill' ? (
          <>
            <PluginSection
              title={t('pluginRecommended')}
              emptyText={t('pluginNoResults')}
              items={recommendedItems}
              busyId={busyId}
              isInstalled={isInstalled}
              onAdd={addItem}
              onPreview={(item) => void openSkillPreview(item)}
              configuringItemId={configuringItemId}
              renderConfig={renderConfigPanel}
              t={t}
            />

            <PluginSection
              title={t('pluginPersonal')}
              emptyText={t('pluginPersonalEmpty')}
              items={personalItems}
              busyId={busyId}
              isInstalled={isInstalled}
              onAdd={addItem}
              onPreview={(item) => void openSkillPreview(item)}
              configuringItemId={configuringItemId}
              renderConfig={renderConfigPanel}
              t={t}
            />
          </>
        ) : null}

        {activeKind === 'mcp' ? (
          <div className="mt-8 flex items-center gap-2 text-[12px] text-ds-faint">
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{t('pluginMcpRestartHint')}</span>
          </div>
        ) : null}
      </div>
      {previewItem ? (
        <SkillPreviewDialog
          item={previewItem}
          markdown={previewMarkdown}
          loading={previewLoading}
          error={previewError}
          installed={isInstalled(previewItem)}
          busy={busyId === storageKey(previewItem.kind, previewItem.id)}
          onClose={closeSkillPreview}
          onAdd={() => void addItem(previewItem)}
          onTry={() => trySkill(previewItem)}
          onCopy={() => void copySkillPrompt(previewItem)}
          onOpenLocation={() => void openSkillLocation(previewItem)}
          t={t}
        />
      ) : null}
    </div>
  )
}

function McpRuntimeOverlayPanel({
  overlay,
  loading,
  error,
  onRefresh,
  t
}: {
  overlay: McpMarketplaceOverlay
  loading: boolean
  error: string
  onRefresh: () => void
  t: (key: string, values?: Record<string, unknown>) => string
}): ReactElement {
  const status = mcpRuntimeStatusLabel(overlay.status, t)
  const displayServerIds = groupedMcpServerIds(overlay.serverIds)
  return (
    <section className="mt-4 rounded-[var(--lg-radius-selection)] border border-ds-border bg-[var(--ds-card-soft)] px-4 py-3.5 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-[color-mix(in_srgb,var(--ds-accent)_7%,transparent)] text-[color-mix(in_srgb,var(--ds-accent)_68%,var(--ds-muted))]">
            <Info className="h-[17px] w-[17px]" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-semibold text-ds-ink">{t('pluginMcpRuntimeOverlay')}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${mcpRuntimeStatusTone(overlay.status)}`}>
                {status}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ds-muted">
              <span>{t('pluginMcpRuntimeServers', {
                connected: overlay.connectedServers,
                configured: overlay.configuredServers
              })}</span>
              <span>{t('pluginMcpRuntimeTools', { count: overlay.toolCount })}</span>
              <span>{t('pluginMcpRuntimeSearch', {
                mode: overlay.searchMode,
                status: overlay.searchActive ? t('pluginMcpRuntimeSearchActive') : t('pluginMcpRuntimeSearchInactive'),
                indexed: overlay.indexedToolCount,
                advertised: overlay.advertisedToolCount
              })}</span>
              {overlay.driftCount > 0 ? <span>{t('pluginMcpRuntimeDrift', { count: overlay.driftCount })}</span> : null}
            </div>
            {displayServerIds.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {displayServerIds.map((id) => (
                  <span
                    key={id}
                    className="rounded-full border border-ds-border-muted bg-ds-subtle/80 px-2.5 py-1 text-[11.5px] font-medium tracking-[-0.006em] text-ds-muted"
                  >
                    {id}
                  </span>
                ))}
              </div>
            ) : null}
            {error || overlay.lastError ? (
              <div className="mt-2 truncate text-[12px] text-red-700 dark:text-red-300">
                {error || t('pluginMcpRuntimeLastError', { message: overlay.lastError })}
              </div>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-[8px] border border-ds-border bg-[var(--ds-card-soft)] px-3 text-[11.5px] font-semibold text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t('pluginMcpRuntimeRefresh')}
        </button>
      </div>
    </section>
  )
}

function groupedMcpServerIds(serverIds: string[]): string[] {
  let hasPkulaw = false
  let hasYuandian = false
  const grouped: string[] = []
  for (const id of serverIds) {
    if (isPkulawMcpEndpointId(id)) {
      hasPkulaw = true
      continue
    }
    if (isYuandianMcpEndpointId(id)) {
      hasYuandian = true
      continue
    }
    grouped.push(id)
  }
  if (hasPkulaw) grouped.push(PKULAW_MCP_GROUP_ID)
  if (hasYuandian) grouped.push(YUANDIAN_MCP_GROUP_ID)
  return grouped.sort((left, right) => left.localeCompare(right))
}

function mcpRuntimeStatusLabel(
  status: McpMarketplaceOverlayStatus,
  t: (key: string) => string
): string {
  switch (status) {
    case 'connected':
      return t('pluginMcpRuntimeConnected')
    case 'configured':
      return t('pluginMcpRuntimeConfigured')
    case 'drift':
      return t('pluginMcpRuntimeDrifted')
    case 'error':
      return t('pluginMcpRuntimeError')
    case 'disabled':
      return t('pluginMcpRuntimeDisabled')
    case 'offline':
      return t('pluginMcpRuntimeOffline')
  }
}

function mcpRuntimeStatusTone(status: McpMarketplaceOverlayStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200'
    case 'configured':
      return 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-200'
    case 'drift':
      return 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-200'
    case 'error':
      return 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-200'
    case 'disabled':
    case 'offline':
      return 'bg-ds-subtle text-ds-muted'
  }
}

function marketplaceSourceTone(tone: MarketplaceItem['statusTone']): string {
  switch (tone) {
    case 'success':
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200'
    case 'warning':
      return 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-200'
    case 'error':
      return 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
    case 'default':
    default:
      return 'bg-ds-subtle text-ds-muted'
  }
}

function runtimeOverlayErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return /runtimeRequest|dsGui|Cannot read properties/i.test(message) ? fallback : message
}

function PluginSection({
  title,
  emptyText,
  items,
  busyId,
  isInstalled,
  onAdd,
  onPreview,
  configuringItemId,
  renderConfig,
  t
}: {
  title: string
  emptyText: string
  items: MarketplaceItem[]
  busyId: string | null
  isInstalled: (item: Pick<MarketplaceItem, 'kind' | 'id'>) => boolean
  onAdd: (item: MarketplaceItem) => Promise<void>
  onPreview?: (item: MarketplaceItem) => void
  configuringItemId?: string | null
  renderConfig?: (item: MarketplaceItem) => ReactNode
  t: (key: string, values?: Record<string, unknown>) => string
}): ReactElement {
  const categoryGroups = groupMarketplaceItemsByCategory(items)
  return (
    <section className="mt-7">
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-ds-ink">
          {title}
        </h2>
        {items.length > 0 ? (
          <span className="rounded-full bg-ds-subtle px-2.5 py-1 text-[11px] font-semibold text-ds-muted">
            {t('pluginItemCount', { count: items.length })}
          </span>
        ) : null}
      </div>
      {items.length === 0 ? (
        <div className="rounded-[var(--lg-radius-selection)] border border-dashed border-ds-border bg-[var(--ds-card-soft)] px-5 py-10 text-center text-[14px] text-ds-faint">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-4">
          {categoryGroups.map((group) => (
            <div
              key={group.category}
              className="rounded-[var(--lg-radius-selection)] border border-ds-border bg-[var(--ds-card-soft)] p-3 shadow-sm md:p-4"
            >
              <div className="mb-3 flex items-center gap-3 px-1">
                {(() => {
                  const CategoryIcon = CATEGORY_ICONS[group.category]
                  return (
                    <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[color-mix(in_srgb,var(--ds-accent)_6%,transparent)] text-[var(--ds-muted)]">
                      <CategoryIcon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                    </span>
                  )
                })()}
                <div className="min-w-0">
                  <h3 className="text-[14px] font-semibold text-ds-ink">
                    {marketplaceCategoryLabel(group.category, t)}
                  </h3>
                  <p className="text-[11.5px] text-ds-faint">
                    {t('pluginCategoryItemCount', { count: group.items.length })}
                  </p>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {group.items.map((item) => {
                  const itemKey = storageKey(item.kind, item.id)
                  const installed = isInstalled(item)
                  const needsConfiguration = installed && item.configurable && (item.needsToken || item.id === 'pkulaw' || item.id === 'yuandian' || item.id === IMA_KB_ID)
                  const busy = busyId === itemKey
                  const configuring = configuringItemId === item.id
                  const previewable = item.kind === 'skill' && !!onPreview
                  const statusLabel = item.sourceLabel ??
                    (item.systemManaged ? t('pluginBuiltIn') : installed ? t('pluginAdded') : t('pluginRecommended'))
                  const statusTone = item.sourceLabel
                    ? marketplaceSourceTone(item.statusTone)
                    : item.systemManaged
                      ? 'bg-ds-subtle text-ds-muted'
                      : installed
                        ? 'bg-ds-success-soft text-ds-success'
                        : 'bg-accent-soft text-accent'
                  return (
                    <div
                      key={itemKey}
                      role={previewable ? 'button' : undefined}
                      tabIndex={previewable ? 0 : undefined}
                      onClick={previewable ? () => onPreview(item) : undefined}
                      onKeyDown={previewable ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onPreview(item)
                        }
                      } : undefined}
                      className={`group flex min-h-[126px] flex-col rounded-[var(--lg-radius-selection)] border border-ds-border-muted bg-[color-mix(in_srgb,var(--ds-card-soft)_82%,transparent)] p-4 outline-none transition duration-150 hover:border-ds-border hover:bg-[var(--ds-card-soft)] hover:shadow-sm ${previewable ? 'cursor-pointer focus-visible:ring-2 focus-visible:ring-accent/30' : ''} ${configuring ? 'md:col-span-2' : ''}`}
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ds-ink">
                            {itemTitle(item, t)}
                            </span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${statusTone}`}
                            >
                              {statusLabel}
                            </span>
                          </div>
                          <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-ds-muted">
                            {itemDescription(item, t)}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={(installed && !needsConfiguration) || busy}
                          onClick={(event) => {
                            event.stopPropagation()
                            void onAdd(item)
                          }}
                          title={needsConfiguration ? t('pluginConfigureToken') : installed ? t('pluginAdded') : t('pluginAdd')}
                          className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[8px] px-2.5 text-[11.5px] font-semibold transition ${
                            needsConfiguration
                              ? 'border border-ds-border bg-ds-card text-ds-ink shadow-sm hover:bg-ds-hover'
                              : installed
                                ? 'cursor-default bg-ds-success-soft text-ds-success'
                                : 'bg-accent text-white shadow-[0_7px_16px_rgba(0,136,255,0.2)] hover:brightness-105 disabled:opacity-60'
                          }`}
                        >
                          {busy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                          ) : needsConfiguration ? (
                            <>
                              <Settings className="h-3.5 w-3.5" strokeWidth={1.9} />
                              <span>{t('pluginConfigure')}</span>
                            </>
                          ) : installed ? (
                            <>
                              <Check className="h-3.5 w-3.5" strokeWidth={2} />
                              <span>{t('pluginAdded')}</span>
                            </>
                          ) : (
                            <>
                              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                              <span>{t('pluginAdd')}</span>
                            </>
                          )}
                        </button>
                      </div>
                      {configuring && renderConfig ? (
                        <div className="mt-4 w-full border-t border-ds-border-muted pt-4">{renderConfig(item)}</div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function SkillPreviewDialog({
  item,
  markdown,
  loading,
  error,
  installed,
  busy,
  onClose,
  onAdd,
  onTry,
  onCopy,
  onOpenLocation,
  t
}: {
  item: MarketplaceItem
  markdown: string
  loading: boolean
  error: string
  installed: boolean
  busy: boolean
  onClose: () => void
  onAdd: () => void
  onTry: () => void
  onCopy: () => void
  onOpenLocation: () => void
  t: (key: string, values?: Record<string, unknown>) => string
}): ReactElement {
  const title = itemTitle(item, t)
  const description = itemDescription(item, t)
  const source = item.sourceLabel || marketplaceCategoryLabel(inferMarketplaceCategory(item), t)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/18 px-4 py-8 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[88vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[22px] border border-ds-border bg-ds-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-6">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-ds-border bg-ds-subtle text-ds-ink shadow-sm">
              <span className="text-[18px] font-semibold">{title.slice(0, 1).toUpperCase()}</span>
            </div>
            <div className="min-w-0 pt-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <h2 className="truncate text-[24px] font-semibold leading-tight text-ds-ink">
                  {title}
                </h2>
                <span className="text-[20px] font-medium text-ds-faint">Skill</span>
              </div>
              {description ? (
                <p className="mt-2 max-w-[620px] text-[16px] leading-7 text-ds-muted">
                  {description}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${marketplaceSourceTone(item.statusTone)}`}>
                  {source}
                </span>
                <span className="rounded-md border border-ds-border-muted bg-ds-subtle px-2 py-0.5 text-[11.5px] font-medium tracking-[-0.006em] text-ds-muted">
                  /skill:{item.id}
                </span>
              </div>
            </div>
          </div>
          <div data-control-hover-root className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-control-hover-ignore
              onClick={installed ? undefined : onAdd}
              disabled={installed || busy}
              title={installed ? t('pluginAdded') : t('pluginAdd')}
              className={`relative h-7 w-[48px] rounded-full transition ${installed ? 'bg-accent' : 'bg-ds-subtle hover:bg-ds-hover'} disabled:cursor-default`}
            >
              <span
                className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition ${installed ? 'left-[22px]' : 'left-1'}`}
              />
              {busy ? <Loader2 className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 animate-spin text-ds-ink" /> : null}
            </button>
            <button
              type="button"
              onClick={onOpenLocation}
              title={t('pluginSkillPreviewOpenLocation')}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            >
              <MoreHorizontal className="h-4 w-4" strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={onClose}
              title={t('pluginSkillPreviewClose')}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            >
              <X className="h-4 w-4" strokeWidth={1.9} />
            </button>
          </div>
        </div>

        <div className="mx-6 mt-6 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-ds-border bg-ds-main/40 px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-[13px] text-ds-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('pluginSkillPreviewLoading')}
            </div>
          ) : (
            <AssistantMarkdown
              text={markdown || t('pluginSkillPreviewEmpty')}
              streaming={false}
              className="ds-markdown ds-chat-answer max-w-none break-words text-[14px] leading-6 text-ds-ink"
            />
          )}
          {error ? (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-300">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-5">
          <button
            type="button"
            onClick={onOpenLocation}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-red-50 px-3 text-[13px] font-semibold text-red-600 transition hover:bg-red-100 dark:bg-red-950/20 dark:text-red-300 dark:hover:bg-red-950/35"
          >
            <ExternalLink className="h-4 w-4" strokeWidth={1.8} />
            {t('pluginSkillPreviewOpenLocation')}
          </button>
          <div data-control-hover-root className="flex items-center gap-2">
            {!installed ? (
              <button
                type="button"
                onClick={onAdd}
                disabled={busy}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 text-[13px] font-semibold text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {t('pluginAdd')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onTry}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--ds-text)] px-4 text-[13px] font-semibold text-[var(--ds-bg-main)] shadow-sm transition hover:opacity-90"
            >
              <PlayCircle className="h-4 w-4" strokeWidth={1.8} />
              {t('pluginSkillPreviewTry')}
            </button>
            <button
              type="button"
              onClick={onCopy}
              title={t('pluginSkillPreviewCopyCommand')}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-ds-border bg-ds-card text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink"
            >
              <Copy className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function CustomPluginPanel({
  activeKind,
  customName,
  customDescription,
  customCommand,
  customArgs,
  customConfig,
  customSkillBody,
  busy,
  onNameChange,
  onDescriptionChange,
  onCommandChange,
  onArgsChange,
  onConfigChange,
  onSkillBodyChange,
  onAdd
}: {
  activeKind: PluginKind
  customName: string
  customDescription: string
  customCommand: string
  customArgs: string
  customConfig: string
  customSkillBody: string
  busy: boolean
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onCommandChange: (value: string) => void
  onArgsChange: (value: string) => void
  onConfigChange: (value: string) => void
  onSkillBodyChange: (value: string) => void
  onAdd: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  return (
    <section className="mt-6 rounded-2xl border border-ds-border bg-ds-card/95 p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2">
        <input
          value={customName}
          onChange={(event) => onNameChange(event.target.value)}
          className="h-10 rounded-xl border border-ds-border bg-ds-main/45 px-3 text-[14px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
          placeholder={t('pluginCustomName')}
        />
        <input
          value={customDescription}
          onChange={(event) => onDescriptionChange(event.target.value)}
          className="h-10 rounded-xl border border-ds-border bg-ds-main/45 px-3 text-[14px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
          placeholder={t('pluginCustomDescription')}
        />
      </div>
      {activeKind === 'mcp' ? (
        <div className="mt-3 grid gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <input
              value={customCommand}
              onChange={(event) => onCommandChange(event.target.value)}
              className="h-10 rounded-xl border border-ds-border bg-ds-main/45 px-3 text-[14px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
              placeholder={t('pluginCustomCommand')}
            />
            <textarea
              value={customArgs}
              onChange={(event) => onArgsChange(event.target.value)}
              className="min-h-[80px] rounded-xl border border-ds-border bg-ds-main/45 px-3 py-2 font-mono text-[13px] leading-5 text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
              placeholder={t('pluginCustomArgs')}
              spellCheck={false}
            />
          </div>
          <textarea
            value={customConfig}
            onChange={(event) => onConfigChange(event.target.value)}
            className="min-h-[120px] rounded-xl border border-ds-border bg-ds-main/45 px-3 py-2 font-mono text-[13px] leading-5 text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
            placeholder={t('pluginCustomMcpConfig')}
            spellCheck={false}
          />
        </div>
      ) : (
        <textarea
          value={customSkillBody}
          onChange={(event) => onSkillBodyChange(event.target.value)}
          className="mt-3 min-h-[140px] w-full rounded-xl border border-ds-border bg-ds-main/45 px-3 py-2 font-mono text-[13px] leading-5 text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
          placeholder={t('pluginCustomSkillBody')}
          spellCheck={false}
        />
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onAdd}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-xl bg-ds-userbubble px-4 py-2 text-[13px] font-semibold text-ds-userbubbleFg shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : <Plus className="h-4 w-4" strokeWidth={2} />}
          {t('pluginAddCustom')}
        </button>
      </div>
    </section>
  )
}

function PkulawConfigPanel({
  token,
  onTokenChange,
  onAdd,
  onCancel,
  busy,
  t
}: {
  token: string
  onTokenChange: (value: string) => void
  onAdd: () => void
  onCancel: () => void
  busy: boolean
  t: (key: string, values?: Record<string, unknown>) => string
}): ReactElement {
  const [showToken, setShowToken] = useState(false)
  return (
    <div className="rounded-2xl border border-ds-border bg-ds-card/95 p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="min-w-0 flex-1">
          <label className="block text-[12px] font-semibold text-ds-muted">
            {t('pluginMcpPkulawTokenLabel')}
          </label>
          <div className="relative mt-1.5">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(event) => onTokenChange(event.target.value)}
              placeholder={t('pluginMcpPkulawTokenPlaceholder')}
              autoComplete="off"
              className="w-full rounded-xl border border-ds-border bg-ds-main/45 px-3 py-2 pr-20 text-[14px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
            />
            <button
              type="button"
              onClick={() => setShowToken((value) => !value)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            >
              {showToken ? t('pluginMcpPkulawTokenHide') : t('pluginMcpPkulawTokenShow')}
            </button>
          </div>
          <p className="mt-2 text-[12px] leading-5 text-ds-faint">
            {t('pluginMcpPkulawTokenHint')}
          </p>
        </div>
        <div data-control-hover-root className="flex shrink-0 items-center gap-2 md:pt-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-55"
          >
            {t('pluginMcpPkulawCancel')}
          </button>
          <button
            type="button"
            onClick={onAdd}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl bg-ds-userbubble px-3 py-2 text-[13px] font-semibold text-ds-userbubbleFg shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : <Plus className="h-4 w-4" strokeWidth={2} />}
            {token.trim() ? t('pluginMcpPkulawUpdate') : t('pluginMcpPkulawAdd')}
          </button>
        </div>
      </div>
    </div>
  )
}

function YuandianConfigPanel({
  apiKey,
  onApiKeyChange,
  onAdd,
  onCancel,
  busy,
  t
}: {
  apiKey: string
  onApiKeyChange: (value: string) => void
  onAdd: () => void
  onCancel: () => void
  busy: boolean
  t: (key: string, values?: Record<string, unknown>) => string
}): ReactElement {
  const [showKey, setShowKey] = useState(false)
  return (
    <div className="rounded-2xl border border-ds-border bg-ds-card/95 p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="min-w-0 flex-1">
          <label className="block text-[12px] font-semibold text-ds-muted">
            {t('pluginMcpYuandianKeyLabel')}
          </label>
          <div className="relative mt-1.5">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
              placeholder={t('pluginMcpYuandianKeyPlaceholder')}
              autoComplete="off"
              className="w-full rounded-xl border border-ds-border bg-ds-main/45 px-3 py-2 pr-20 text-[14px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
            />
            <button
              type="button"
              onClick={() => setShowKey((value) => !value)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            >
              {showKey ? t('pluginMcpPkulawTokenHide') : t('pluginMcpPkulawTokenShow')}
            </button>
          </div>
          <p className="mt-2 text-[12px] leading-5 text-ds-faint">
            {t('pluginMcpYuandianKeyHint')}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {YUANDIAN_MCP_ENDPOINTS.map((endpoint) => (
              <span
                key={endpoint.id}
                className="rounded-md border border-ds-border-muted bg-ds-subtle px-2 py-0.5 text-[11.5px] font-medium tracking-[-0.006em] text-ds-muted"
              >
                {endpoint.id}
              </span>
            ))}
          </div>
        </div>
        <div data-control-hover-root className="flex shrink-0 items-center gap-2 md:pt-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-55"
          >
            {t('pluginMcpPkulawCancel')}
          </button>
          <button
            type="button"
            onClick={onAdd}
            disabled={busy || !apiKey.trim()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-ds-userbubble px-3 py-2 text-[13px] font-semibold text-ds-userbubbleFg shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : <Plus className="h-4 w-4" strokeWidth={2} />}
            {apiKey.trim() ? t('pluginMcpPkulawUpdate') : t('pluginMcpYuandianAdd')}
          </button>
        </div>
      </div>
    </div>
  )
}

function AnysearchConfigPanel({
  apiKey,
  onApiKeyChange,
  onAdd,
  onCancel,
  busy,
  t
}: {
  apiKey: string
  onApiKeyChange: (value: string) => void
  onAdd: () => void
  onCancel: () => void
  busy: boolean
  t: (key: string, values?: Record<string, unknown>) => string
}): ReactElement {
  const [showKey, setShowKey] = useState(false)
  return (
    <div className="rounded-2xl border border-ds-border bg-ds-card/95 p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="min-w-0 flex-1">
          <label className="block text-[12px] font-semibold text-ds-muted">
            {t('pluginMcpAnysearchKeyLabel')}
          </label>
          <div className="relative mt-1.5">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
              placeholder={t('pluginMcpAnysearchKeyPlaceholder')}
              autoComplete="off"
              className="w-full rounded-xl border border-ds-border bg-ds-main/45 px-3 py-2 pr-20 text-[14px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
            />
            <button
              type="button"
              onClick={() => setShowKey((value) => !value)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            >
              {showKey ? t('pluginMcpAnysearchKeyHide') : t('pluginMcpAnysearchKeyShow')}
            </button>
          </div>
          <div className="mt-2 space-y-2 text-[12px] leading-5 text-ds-faint">
            <p>
              {t('pluginMcpAnysearchKeyHint')}
            </p>
            <p>
              <a
                href="https://anysearch.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline hover:opacity-80"
              >
                https://anysearch.com
              </a>
            </p>
            <p>{t('pluginMcpAnysearchRegistrationHint')}</p>
          </div>
        </div>
        <div data-control-hover-root className="flex shrink-0 items-center gap-2 md:pt-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-55"
          >
            {t('pluginMcpPkulawCancel')}
          </button>
          <button
            type="button"
            onClick={onAdd}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl bg-ds-userbubble px-3 py-2 text-[13px] font-semibold text-ds-userbubbleFg shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : <Plus className="h-4 w-4" strokeWidth={2} />}
            {apiKey.trim() ? t('pluginMcpPkulawUpdate') : t('pluginMcpAnysearchAdd')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ImaConfigPanel({
  loggedIn,
  status = loggedIn ? 'valid' : 'not_configured',
  statusMessage = '',
  knowledgeBaseCount = 0,
  loggingIn,
  reloggingIn,
  onLogin,
  onRelogin,
  onCancel,
  t
}: {
  loggedIn: boolean
  status?: ImaConnectionStatus
  statusMessage?: string
  knowledgeBaseCount?: number
  loggingIn: boolean
  reloggingIn: boolean
  onLogin: () => void
  onRelogin: () => void
  onCancel: () => void
  t: (key: string, values?: Record<string, unknown>) => string
}): ReactElement {
  return (
    <div className="rounded-2xl border border-ds-border bg-ds-card/95 p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between">
            <label className="block text-[12px] font-semibold text-ds-muted">
              {t('pluginMcpImaTitle')}
            </label>
            {loggedIn ? (
              <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-[11px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                {t('pluginMcpImaLoggedIn')}
              </span>
            ) : status === 'expired' ? (
              <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                {t('pluginMcpImaExpired')}
              </span>
            ) : status === 'network_error' ? (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                {t('pluginMcpImaUnknown')}
              </span>
            ) : null}
          </div>
          <div className="mt-2 space-y-2 text-[12px] leading-5 text-ds-faint">
            <p>{t('pluginMcpImaDesc')}</p>
            <p>{t(loggedIn ? 'pluginMcpImaReloginHint' : 'pluginMcpImaLoginHint')}</p>
            {loggedIn ? <p>{t('pluginMcpImaKnowledgeBaseCount', { count: knowledgeBaseCount })}</p> : null}
            {statusMessage ? <p className="text-red-600 dark:text-red-400">{statusMessage}</p> : null}
          </div>
        </div>
        <div data-control-hover-root className="flex shrink-0 items-center gap-2 md:pt-5">
          <button
            type="button"
            onClick={onCancel}
            disabled={loggingIn || reloggingIn}
            className="inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-55"
          >
            {t('pluginMcpPkulawCancel')}
          </button>
          {loggedIn ? (
            <button
              type="button"
              onClick={onRelogin}
              disabled={loggingIn || reloggingIn}
              className="inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-55"
            >
              {reloggingIn ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
              ) : (
                <RefreshCw className="h-4 w-4" strokeWidth={1.9} />
              )}
              {t('pluginMcpImaRelogin')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onLogin}
            disabled={loggingIn || reloggingIn}
            className="inline-flex items-center gap-1.5 rounded-xl bg-ds-userbubble px-3 py-2 text-[13px] font-semibold text-ds-userbubbleFg shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55"
          >
            {loggingIn ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : loggedIn ? (
              <span className="flex h-4 w-4 items-center justify-center text-green-500">✓</span>
            ) : (
              <Plus className="h-4 w-4" strokeWidth={2} />
            )}
            {loggedIn ? t('pluginMcpImaReconnect') : t('pluginMcpImaLogin')}
          </button>
        </div>
      </div>
    </div>
  )
}
