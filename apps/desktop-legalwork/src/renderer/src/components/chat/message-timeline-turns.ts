import type { ChatBlock } from '../../agent/types'

export type Turn = {
  user?: Extract<ChatBlock, { kind: 'user' }>
  blocks: ChatBlock[]
}

export function groupTurns(blocks: ChatBlock[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  for (const block of blocks) {
    if (block.kind === 'user') {
      if (current) turns.push(current)
      current = { user: block, blocks: [] }
      continue
    }
    if (!current) current = { blocks: [] }
    current.blocks.push(block)
  }

  if (current) turns.push(current)
  return turns
}

export function splitThink(text: string): { think: string; content: string } {
  const match = text.match(/<think>([\s\S]*?)(?:<\/think>|$)/)
  if (!match) return { think: '', content: text }
  return {
    think: match[1].trim(),
    content: text.replace(/<think>[\s\S]*?(?:<\/think>|$)/, '').trim()
  }
}

export function blockHasPendingRuntimeWork(block: ChatBlock): boolean {
  if (block.kind === 'tool') return block.status === 'running'
  if (block.kind === 'compaction') return block.status === 'running'
  if (block.kind === 'review') return block.status === 'running'
  if (block.kind === 'approval') return block.status === 'pending'
  if (block.kind === 'user_input') return block.status === 'pending'
  return false
}

export function isProcessBlock(block: ChatBlock): boolean {
  return (
    block.kind === 'reasoning' ||
    block.kind === 'tool' ||
    block.kind === 'compaction' ||
    block.kind === 'approval' ||
    block.kind === 'user_input' ||
    block.kind === 'system'
  )
}

export function turnHasPendingRuntimeWork(turn: Turn): boolean {
  return turn.blocks.some(blockHasPendingRuntimeWork)
}

export function findTrailingAssistantContentStart(blocks: ChatBlock[]): number {
  // Everything produced after the final actionable process block belongs to
  // the answer phase. Reasoning can legitimately be persisted between two
  // assistant_text items (a full answer followed by a short wrap-up); it must
  // not make the UI discard the earlier, substantive text.
  let lastProcessBoundary = -1
  for (const [index, block] of blocks.entries()) {
    if (block.kind !== 'assistant' && block.kind !== 'reasoning') {
      lastProcessBoundary = index
    }
  }

  for (let index = lastProcessBoundary + 1; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.kind !== 'assistant') continue
    if (splitThink(block.text).content.trim()) return index
  }
  return blocks.length
}
