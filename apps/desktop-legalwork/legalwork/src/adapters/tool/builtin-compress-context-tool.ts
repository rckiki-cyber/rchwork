import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { withToolBoundary } from './builtin-tool-utils.js'
import type { ContextCompactor, CompactionMode } from '../../loop/context-compactor.js'
import type { ImmutablePrefix } from '../../cache/immutable-prefix.js'
import type { SessionStore } from '../../ports/session-store.js'
import type { RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'
import type { UsageService } from '../../services/usage-service.js'
import { estimateDeepseekInputTokenCost } from '../model/deepseek-pricing.js'

export type CompressContextLocalToolOptions = {
  compactor: ContextCompactor
  prefix: ImmutablePrefix
  sessionStore: SessionStore
  events: RuntimeEventRecorder
  usage: UsageService
}

/**
 * Factory for the `compress_context` built-in tool.
 *
 * The agent can call this tool to explicitly compress conversation
 * history when the context grows large, reducing token consumption
 * and cost. Compression reuses the existing ContextCompactor and
 * reports token/cost savings back to the agent.
 */
export function createCompressContextLocalTool(
  options: CompressContextLocalToolOptions
): LocalTool {
  const { compactor, prefix, sessionStore, events, usage } = options

  return LocalToolHost.defineTool({
    name: 'compress_context',
    description: [
      '当对话历史较长、token 消耗较大时，显式压缩上下文以降低后续请求的费用。',
      '压缩后旧的对话记录会被替换为一段摘要，减少后续请求的输入 token 数量。',
      '',
      '建议在以下时机调用：',
      '- 完成一个重要子任务后',
      '- 开始新的工作阶段前',
      '- 你觉得上下文已较为庞大时',
      '',
      '参数说明：',
      '- `keep_recent`：保留最近多少条完整的对话记录，默认 4。',
      '- `mode`：压缩模式，"normal"=普通（保留最近 4 条）、"aggressive"=激进（保留最近 2 条）、"force"=强制（只保留最近 1 条）。',
      '',
      '调用后会返回节省的 token 数量和预估费用。'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        keep_recent: {
          type: 'number',
          description: '保留最近多少条完整的对话记录（默认 4）',
          default: 4
        },
        mode: {
          type: 'string',
          enum: ['normal', 'aggressive', 'force'],
          description: '压缩模式：normal=普通(保留4条), aggressive=激进(保留2条), force=强制(保留1条)'
        }
      },
      additionalProperties: false
    },
    policy: 'auto',
    toolKind: 'tool_call',
    execute: async (args, context) =>
      withToolBoundary(async () => {
        const keepRecentRaw = typeof args.keep_recent === 'number' ? args.keep_recent : 4
        const keepRecent = Math.max(1, Math.min(20, Math.floor(keepRecentRaw)))
        const modeRaw = typeof args.mode === 'string' ? args.mode : 'normal'
        const mode: CompactionMode =
          modeRaw === 'normal' || modeRaw === 'aggressive' || modeRaw === 'force'
            ? modeRaw
            : 'normal'

        const { threadId, turnId, abortSignal } = context

        // 1. Load current history from session store
        const items = await sessionStore.loadItems(threadId)

        // 2. Compact via ContextCompactor
        const result = compactor.compact({
          threadId,
          turnId,
          history: items,
          prefix,
          reason: `compress_context tool invoked by agent (mode=${mode}, keepRecent=${keepRecent})`,
          mode,
          keepRecent
        })

        if (abortSignal.aborted) {
          return { output: { error: '压缩被中断' }, isError: true }
        }

        if (result.replacedTokens <= 0) {
          return {
            output: {
              replaced_tokens: 0,
              estimated_cost_savings_usd: 0,
              estimated_cost_savings_cny: 0,
              mode_used: mode,
              items_compacted: 0,
              message: '上下文较短，无需压缩。'
            }
          }
        }

        // 3. Persist compacted history (replace old items with compressed version)
        await sessionStore.rewriteItems(threadId, result.next)

        // 4. Record compaction event
        const summaryText =
          result.summaryItem.kind === 'compaction' ? result.summaryItem.summary : ''
        await events.record({
          kind: 'compaction_completed',
          threadId,
          turnId,
          itemId: result.summaryItem.id,
          summary: summaryText,
          replacedTokens: result.replacedTokens,
          pinnedConstraints: prefix.pinnedConstraints,
          ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceDigest
            ? { sourceDigest: result.summaryItem.sourceDigest }
            : {}),
          ...(result.summaryItem.kind === 'compaction' && result.summaryItem.digestMarker
            ? { digestMarker: result.summaryItem.digestMarker }
            : {}),
          ...(result.summaryItem.kind === 'compaction' && result.summaryItem.sourceItemIds
            ? { sourceItemIds: result.summaryItem.sourceItemIds }
            : {})
        })

        // 5. Record cost savings
        const modelId = typeof context.model?.id === 'string' ? context.model.id : ''
        const cost = estimateDeepseekInputTokenCost({
          model: modelId,
          inputTokens: result.replacedTokens
        })
        if (cost) {
          usage.recordTokenEconomySavings(threadId, {
            tokenEconomySavingsTokens: result.replacedTokens,
            tokenEconomySavingsUsd: cost.costUsd,
            tokenEconomySavingsCny: cost.costCny
          })
        }

        // 6. Count source items
        const sourceItemCount =
          result.summaryItem.kind === 'compaction' && result.summaryItem.sourceItemIds
            ? result.summaryItem.sourceItemIds.length
            : 0

        return {
          output: {
            replaced_tokens: result.replacedTokens,
            estimated_cost_savings_usd: cost?.costUsd ?? 0,
            estimated_cost_savings_cny: cost?.costCny ?? 0,
            mode_used: mode,
            items_compacted: sourceItemCount,
            message: `已完成压缩：${sourceItemCount} 条对话记录被替换为摘要，节省约 ${result.replacedTokens} 个输入 token，预估节省 $${(cost?.costUsd ?? 0).toFixed(6)} USD / ¥${(cost?.costCny ?? 0).toFixed(4)} CNY。`
          }
        }
      })
  })
}
