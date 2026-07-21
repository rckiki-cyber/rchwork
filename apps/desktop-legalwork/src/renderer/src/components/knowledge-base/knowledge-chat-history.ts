import type { ChatBlock } from '../../agent/types'

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export type KnowledgeChatContext =
  | { kind: 'global' }
  | { kind: 'file'; fileName: string }

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
  return fileName ? { kind: 'file', fileName } : null
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
