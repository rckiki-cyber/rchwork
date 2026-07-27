import type { ChatBlock } from '../../agent/types'
import type { KnowledgeTreeNode } from './types'

export type KnowledgeChatSource = {
  path: string
  title: string
  citation?: string
  excerpt?: string
  relevanceScore?: number
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  reasoning?: string
  sources?: KnowledgeChatSource[]
  sourceScope?: string
  streaming?: boolean
}

export type KnowledgeChatContext =
  | { kind: 'global' }
  | { kind: 'file'; fileName: string; filePath?: string }

export type KnowledgeChatHistory = {
  messages: ChatMessage[]
  context: KnowledgeChatContext
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractMarkdownSection(text: string, heading: string): string | null {
  const pattern = new RegExp(`(?:^|\\n)##\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`)
  const match = text.match(pattern)
  return match?.[1]?.trim() || null
}

function restoreKnowledgeUserQuestion(text: string): string {
  const userQuestion = extractMarkdownSection(text, '用户问题')
  if (!userQuestion) return text
  return userQuestion
    .split(/\n{2,}请(?:基于|根据|结合)/)[0]
    .trim()
}

function normalizeKnowledgeFileName(value: string): string {
  return value
    .replace(/（[^）]*）\s*$/, '')
    .replace(/\([^)]*\)\s*$/, '')
    .trim()
}

function extractKnowledgeChatContext(text: string): KnowledgeChatContext | null {
  const currentFile = extractMarkdownSection(text, '当前文件')
  const firstLine = currentFile?.split('\n').map((line) => line.trim()).find(Boolean)
  if (!firstLine) return null
  const fileName = normalizeKnowledgeFileName(firstLine)
  if (!fileName) return null
  const filePath = extractMarkdownSection(text, '当前文件路径')?.split('\n')[0]?.trim()
  return filePath ? { kind: 'file', fileName, filePath } : { kind: 'file', fileName }
}

function extractKnowledgeSources(text: string): KnowledgeChatSource[] {
  const section = extractMarkdownSection(text, '可引用来源')
  if (!section) return []
  const sources: KnowledgeChatSource[] = []
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim()
    const prefix = line.match(/^\[来源\s*(\d+)\]\s+(.+)$/)
    if (!prefix) continue
    const rest = prefix[2]
    const detailStart = rest.lastIndexOf('（')
    const detail = detailStart >= 0 ? rest.slice(detailStart + 1).replace(/）\s*$/, '') : ''
    const label = detailStart >= 0 ? rest.slice(0, detailStart).trim() : rest.trim()
    const detailMatch = detail.match(/^(.+?)，相关度\s*(\d+)%$/)
    const path = detailMatch?.[1]?.trim()
    if (!path) continue
    sources[Number(prefix[1]) - 1] = {
      path,
      title: label || path.split('/').pop() || path,
      citation: label || undefined,
      relevanceScore: detailMatch?.[2] ? Number(detailMatch[2]) / 100 : undefined
    }
  }
  return sources.filter(Boolean)
}

function splitLegacyAssistantContent(text: string): { content: string; reasoning?: string } {
  const legacy = text.match(/^\s*<details[^>]*>\s*<summary[^>]*>[\s\S]*?思考过程\s*<\/summary>\s*([\s\S]*?)\s*<\/details>\s*([\s\S]*)$/i)
  if (!legacy) return { content: text }
  return {
    reasoning: legacy[1].trim() || undefined,
    content: legacy[2].trim()
  }
}

function linkKnowledgeCitations(text: string, scope: string): string {
  const encodedScope = encodeURIComponent(scope)
  return text.replace(
    /\[来源\s*(\d+)\](?!\()/g,
    (_match, number: string) => `[${number}](source://${encodedScope}/${number})`
  )
}

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
}

function collectFiles(nodes: KnowledgeTreeNode[]): KnowledgeTreeNode[] {
  const files: KnowledgeTreeNode[] = []
  for (const node of nodes) {
    if (node.kind === 'file') {
      files.push(node)
    } else {
      files.push(...collectFiles(node.children ?? []))
    }
  }
  return files
}

export function findKnowledgeFileForChatContext(
  nodes: KnowledgeTreeNode[],
  context: KnowledgeChatContext
): KnowledgeTreeNode | null {
  if (context.kind !== 'file') return null
  const files = collectFiles(nodes)
  if (context.filePath) {
    const targetPath = normalizedPath(context.filePath)
    const pathMatch = files.find((node) => normalizedPath(node.path) === targetPath)
    if (pathMatch) return pathMatch
  }

  const nameMatches = files.filter((node) => node.name === context.fileName)
  return nameMatches.length === 1 ? nameMatches[0] : null
}

export function knowledgeChatHistoryFromBlocks(blocks: ChatBlock[]): KnowledgeChatHistory {
  const messages: ChatMessage[] = []
  let context: KnowledgeChatContext = { kind: 'global' }
  let pendingSources: KnowledgeChatSource[] = []
  for (const block of blocks) {
    if (block.kind === 'user') {
      context = extractKnowledgeChatContext(block.text) ?? context
      pendingSources = extractKnowledgeSources(block.text)
      messages.push({
        id: block.id,
        role: 'user',
        content: restoreKnowledgeUserQuestion(block.text),
        timestamp: block.createdAt ? new Date(block.createdAt).getTime() : Date.now()
      })
    } else if (block.kind === 'assistant') {
      const scope = block.id
      const restored = splitLegacyAssistantContent(block.text)
      messages.push({
        id: block.id,
        role: 'assistant',
        content: linkKnowledgeCitations(restored.content, scope),
        reasoning: restored.reasoning,
        sources: pendingSources.length > 0 ? pendingSources : undefined,
        sourceScope: pendingSources.length > 0 ? scope : undefined,
        timestamp: block.createdAt ? new Date(block.createdAt).getTime() : Date.now()
      })
      pendingSources = []
    }
  }
  return { messages, context }
}
