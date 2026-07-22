import type { ChatBlock } from '../../agent/types'
import type { KnowledgeTreeNode } from './types'

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
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
  for (const block of blocks) {
    if (block.kind === 'user') {
      context = extractKnowledgeChatContext(block.text) ?? context
      messages.push({
        id: block.id,
        role: 'user',
        content: restoreKnowledgeUserQuestion(block.text),
        timestamp: block.createdAt ? new Date(block.createdAt).getTime() : Date.now()
      })
    } else if (block.kind === 'assistant') {
      messages.push({
        id: block.id,
        role: 'assistant',
        content: block.text,
        timestamp: block.createdAt ? new Date(block.createdAt).getTime() : Date.now()
      })
    }
  }
  return { messages, context }
}
