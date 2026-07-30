import type { ChatBlock } from '../../agent/types'
import type { KnowledgeTreeNode } from './types'

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  timestamp: number
}

export type KnowledgeChatContext =
  | { kind: 'global' }
  | { kind: 'file'; fileName: string; filePath?: string }

export type KnowledgeChatHistory = {
  messages: ChatMessage[]
  context: KnowledgeChatContext
}

export const KNOWLEDGE_DIRECT_ANSWER_INSTRUCTION =
  '直接回答用户问题，不要在回答开头重复、改写或概括用户问题；不要把用户问题作为 Markdown 标题、加粗文本或引言单独输出。'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeRepeatedQuestionLine(value: string): string {
  let normalized = value.trim()
  normalized = normalized.replace(/^>\s*/, '')
  normalized = normalized.replace(/^#{1,6}\s*/, '')

  const boldMatch = normalized.match(/^(?:\*\*|__)([\s\S]*?)(?:\*\*|__)$/)
  if (boldMatch) normalized = boldMatch[1]

  return normalized
    .replace(/^(?:用户问题|问题|提问)\s*[:：]\s*/, '')
    .trim()
    .replace(/^[“”"'‘’《》「」『』]+|[“”"'‘’《》「」『』]+$/g, '')
    .replace(/[?？!！。.:：;；，,]+$/g, '')
    .replace(/\s+/g, '')
    .toLocaleLowerCase()
}

export function stripRepeatedKnowledgeQuestionLead(answer: string, question: string): string {
  const normalizedQuestion = normalizeRepeatedQuestionLine(question)
  if (!answer || !normalizedQuestion) return answer

  const firstLineMatch = answer.match(/^(?:[ \t]*\r?\n)*[ \t]*([^\r\n]+)(?:\r?\n|$)/)
  if (!firstLineMatch) return answer

  const normalizedFirstLine = normalizeRepeatedQuestionLine(firstLineMatch[1])
  if (normalizedFirstLine !== normalizedQuestion) return answer

  return answer
    .slice(firstLineMatch[0].length)
    .replace(/^(?:[ \t]*\r?\n)+/, '')
}

function extractMarkdownSection(text: string, heading: string): string | null {
  const pattern = new RegExp(`(?:^|\\n)##\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`)
  const match = text.match(pattern)
  return match?.[1]?.trim() || null
}

function restoreKnowledgeUserQuestion(text: string): string {
  const userQuestion = extractMarkdownSection(text, '用户问题')
  if (!userQuestion) return text

  // New prompts put internal instructions under their own heading, so the
  // section extractor above returns only the visible question. Older stored
  // prompts appended the instructions to the same section; remove those exact
  // legacy suffixes when restoring chat history.
  const legacyInstructionPrefixes = [
    '请优先依据“当前打开文件的正文”回答',
    '请基于检索到的内容给出准确、专业的回答',
    '请基于当前文件给出回答'
  ]
  const instructionStart = legacyInstructionPrefixes
    .map((prefix) => userQuestion.indexOf(`\n\n${prefix}`))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0]

  return (instructionStart === undefined ? userQuestion : userQuestion.slice(0, instructionStart)).trim()
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
  let pendingReasoning = ''
  let latestUserQuestion = ''
  for (const block of blocks) {
    if (block.kind === 'user') {
      pendingReasoning = ''
      context = extractKnowledgeChatContext(block.text) ?? context
      latestUserQuestion = restoreKnowledgeUserQuestion(block.text)
      messages.push({
        id: block.id,
        role: 'user',
        content: latestUserQuestion,
        timestamp: block.createdAt ? new Date(block.createdAt).getTime() : Date.now()
      })
    } else if (block.kind === 'reasoning') {
      pendingReasoning = [pendingReasoning, block.text].filter(Boolean).join('\n\n')
    } else if (block.kind === 'assistant') {
      messages.push({
        id: block.id,
        role: 'assistant',
        content: stripRepeatedKnowledgeQuestionLead(block.text, latestUserQuestion),
        ...(pendingReasoning ? { reasoning: pendingReasoning } : {}),
        timestamp: block.createdAt ? new Date(block.createdAt).getTime() : Date.now()
      })
      pendingReasoning = ''
    }
  }
  return { messages, context }
}
