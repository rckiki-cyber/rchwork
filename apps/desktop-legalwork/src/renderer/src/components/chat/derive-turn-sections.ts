import type { ChatBlock, ToolBlock } from '../../agent/types'
import {
  extractDiffFilePath,
  extractUnifiedDiffText,
  formatFilePathForDisplay,
} from '../../lib/diff-stats'
import {
  findTrailingAssistantContentStart,
  isProcessBlock,
  splitThink,
  type Turn
} from './message-timeline-turns'

export type TurnAssistantBlock = Extract<ChatBlock, { kind: 'assistant' }>

export type TurnSections = {
  processBlocks: ChatBlock[]
  assistantContentBlocks: TurnAssistantBlock[]
  turnFileChanges: ToolBlock[]
}

type DeriveTurnSectionsInput = {
  turn: Turn
  isProcessing: boolean
  liveProcessText: string
  liveContent: string
  workspaceRoot: string
}

function isSubstantiveAssistantContent(text: string): boolean {
  const value = text.trim()
  if (value.length >= 240) return true
  if (value.length >= 120 && /^#{1,6}\s+\S/m.test(value)) return true
  if (value.length >= 120 && /^\s*\|.+\|\s*$/m.test(value) && /^\s*\|?\s*:?-{3,}/m.test(value)) return true
  const listRows = value.match(/^\s*(?:[-*+] |\d+[.)]\s+)/gm)?.length ?? 0
  return value.length >= 160 && listRows >= 3
}

/**
 * Pure derivation of a turn's three view slices:
 *  - `processBlocks`: chronological reasoning/tool/compaction/approval
 *    trace, including in-flight assistant output while a turn is processing.
 *  - `assistantContentBlocks`: assistant content that should render as the
 *    visible message body once it is no longer part of the active work timeline.
 *  - `turnFileChanges`: successful file_change tool blocks whose detail
 *    is a unified diff, with paths normalised for display.
 *
 * Pulled out of `MessageTurn` so the derivation is testable in isolation
 * and the component body stays focused on rendering.
 */
export function deriveTurnSections({
  turn,
  isProcessing,
  liveProcessText,
  liveContent,
  workspaceRoot
}: DeriveTurnSectionsInput): TurnSections {
  const processBlocks: ChatBlock[] = []
  const assistantContentBlocks: TurnAssistantBlock[] = []
  let latestAssistantContentBlock: TurnAssistantBlock | null = null
  const trailingAssistantContentStart = isProcessing
    ? turn.blocks.length
    : findTrailingAssistantContentStart(turn.blocks)

  for (const [index, block] of turn.blocks.entries()) {
    if (block.kind === 'assistant') {
      const split = splitThink(block.text)
      if (split.think) {
        processBlocks.push({ kind: 'reasoning', id: `${block.id}-think`, text: split.think })
      }
      if (split.content.trim()) {
        const contentBlock: TurnAssistantBlock = { ...block, text: split.content }
        latestAssistantContentBlock = contentBlock
        if (isProcessing) {
          processBlocks.push(contentBlock)
        } else if (
          index >= trailingAssistantContentStart ||
          isSubstantiveAssistantContent(contentBlock.text)
        ) {
          assistantContentBlocks.push(contentBlock)
        } else {
          // Short progress prose is still visible data. Keep it in the
          // collapsible process timeline instead of silently dropping it.
          processBlocks.push(contentBlock)
        }
      }
      continue
    }
    if (isProcessBlock(block)) {
      processBlocks.push(block)
    }
  }

  if (!isProcessing && assistantContentBlocks.length === 0 && latestAssistantContentBlock) {
    assistantContentBlocks.push(latestAssistantContentBlock)
    const processIndex = processBlocks.findIndex(
      (block) => block.kind === 'assistant' && block.id === latestAssistantContentBlock.id
    )
    if (processIndex >= 0) processBlocks.splice(processIndex, 1)
  }

  if (liveProcessText.trim()) {
    processBlocks.push({ kind: 'reasoning', id: 'live-reasoning', text: liveProcessText })
  }
  if (isProcessing && liveContent.trim()) {
    const liveText = liveContent.trim()
    const latestText = latestAssistantContentBlock?.text.trim() ?? ''
    if (liveText !== latestText) {
      processBlocks.push({
        kind: 'assistant',
        id: 'live-assistant',
        text: liveContent
      } satisfies TurnAssistantBlock)
    }
  }

  const turnFileChanges: ToolBlock[] = isProcessing
    ? []
    : turn.blocks.flatMap((block): ToolBlock[] => {
        if (
          !(block.kind === 'tool' && block.toolKind === 'file_change' && block.status === 'success')
        ) {
          return []
        }

        const detailText = extractUnifiedDiffText(block.detail)
        if (!detailText) return []

        const resolvedFilePath = formatFilePathForDisplay(
          extractDiffFilePath(detailText, block.filePath),
          workspaceRoot
        )
        if (!resolvedFilePath) return []

        return [{ ...block, detail: detailText, filePath: resolvedFilePath }]
      })

  return { processBlocks, assistantContentBlocks, turnFileChanges }
}
