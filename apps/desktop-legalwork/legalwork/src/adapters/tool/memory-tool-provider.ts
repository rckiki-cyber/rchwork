import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import {
  MemoryCaptureSource,
  MemoryCategory,
  MemoryRecallPolicy,
  MemoryScope
} from '../../contracts/memory.js'
import { MemoryPolicyError } from '../../memory/memory-policy.js'
import type { MemoryStore } from '../../memory/memory-store.js'
import type { ThreadStore } from '../../ports/thread-store.js'

export function buildMemoryToolProviders(
  store: MemoryStore | undefined,
  threadStore?: ThreadStore | undefined
): CapabilityToolProvider[] {
  if (!store) return []
  return [{
    id: 'memory',
    kind: 'memory',
    enabled: true,
    available: true,
    tools: [
      LocalToolHost.defineTool({
        name: 'memory_search',
        description: 'Search active long-term memories before creating, updating, or forgetting one.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            scope: { type: 'string', enum: MemoryScope.options },
            category: { type: 'string', enum: MemoryCategory.options },
            include_deleted: { type: 'boolean' },
            limit: { type: 'number', minimum: 1, maximum: 50 }
          },
          required: ['query'],
          additionalProperties: false
        },
        policy: 'auto',
        execute: async (args, context) => {
          const query = stringArg(args.query)
          if (!query) return toolError('query is required')
          const scope = MemoryScope.safeParse(args.scope)
          const category = MemoryCategory.safeParse(args.category)
          const limit = numberArg(args.limit, 10)
          const result = await store.listPage({
            workspace: context.workspace || undefined,
            project: undefined,
            query,
            scope: scope.success ? scope.data : undefined,
            category: category.success ? category.data : undefined,
            includeDeleted: args.include_deleted === true,
            limit: Math.min(50, Math.max(1, Math.floor(limit)))
          })
          return { output: result }
        }
      }),
      LocalToolHost.defineTool({
        name: 'memory_create',
        description: 'Create or deduplicate a long-term memory. Automatic captures are policy-checked and may require confirmation.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            scope: { type: 'string', enum: MemoryScope.options },
            category: { type: 'string', enum: MemoryCategory.options },
            recall_policy: { type: 'string', enum: MemoryRecallPolicy.options },
            capture_source: {
              type: 'string',
              enum: MemoryCaptureSource.exclude(['legacy']).options
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            workspace: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } }
          },
          required: ['content'],
          additionalProperties: false
        },
        policy: 'auto',
        execute: async (args, context) => {
          const content = stringArg(args.content)
          if (!content) return toolError('content is required')
          const scope = enumArg(MemoryScope, args.scope, 'workspace')
          const category = enumArg(MemoryCategory, args.category, 'other')
          const recallPolicy = enumArg(MemoryRecallPolicy, args.recall_policy, 'relevant')
          const captureSource = enumArg(
            MemoryCaptureSource.exclude(['legacy']),
            args.capture_source,
            'automatic'
          )
          try {
            return {
              output: {
                memory: await store.create({
                  content,
                  scope,
                  category,
                  recallPolicy,
                  captureSource,
                  confidence: numberArg(args.confidence, captureSource === 'automatic' ? 0.8 : 1),
                  workspace: stringArg(args.workspace) || context.workspace || undefined,
                  project: scope === 'project' ? context.workspace || undefined : undefined,
                  sourceThreadId: context.threadId,
                  sourceTurnId: context.turnId,
                  tags: stringArrayArg(args.tags)
                })
              }
            }
          } catch (error) {
            if (error instanceof MemoryPolicyError) {
              return {
                output: {
                  error: error.message,
                  code: error.code,
                  confirmationRequired: error.code === 'confirmation_required'
                },
                isError: true
              }
            }
            throw error
          }
        }
      }),
      LocalToolHost.defineTool({
        name: 'memory_update',
        description: 'Update or disable an existing long-term memory.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            scope: { type: 'string', enum: MemoryScope.options },
            category: { type: 'string', enum: MemoryCategory.options },
            recall_policy: { type: 'string', enum: MemoryRecallPolicy.options },
            tags: { type: 'array', items: { type: 'string' } },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            disabled: { type: 'boolean' },
            restore: { type: 'boolean' }
          },
          required: ['id'],
          additionalProperties: false
        },
        policy: 'on-request',
        execute: async (args, context) => {
          const id = stringArg(args.id)
          if (!id) return toolError('id is required')
          const scope = MemoryScope.safeParse(args.scope)
          const category = MemoryCategory.safeParse(args.category)
          const recallPolicy = MemoryRecallPolicy.safeParse(args.recall_policy)
          return {
            output: {
              memory: await store.update(id, {
                ...(stringArg(args.content) ? { content: stringArg(args.content) } : {}),
                ...(scope.success ? { scope: scope.data } : {}),
                ...(category.success ? { category: category.data } : {}),
                ...(recallPolicy.success ? { recallPolicy: recallPolicy.data } : {}),
                ...(scope.success && scope.data !== 'user'
                  ? {
                      workspace: context.workspace || undefined,
                      project: scope.data === 'project' ? context.workspace || undefined : undefined
                    }
                  : {}),
                ...(Array.isArray(args.tags) ? { tags: stringArrayArg(args.tags) } : {}),
                ...(typeof args.confidence === 'number' ? { confidence: args.confidence } : {}),
                ...(typeof args.disabled === 'boolean' ? { disabled: args.disabled } : {}),
                ...(args.restore === true ? { restore: true } : {})
              })
            }
          }
        }
      }),
      LocalToolHost.defineTool({
        name: 'memory_delete',
        description: 'Delete a long-term memory by writing a tombstone.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false
        },
        policy: 'on-request',
        execute: async (args) => {
          if (typeof args.id !== 'string') return { output: { error: 'id is required' }, isError: true }
          return { output: { memory: await store.delete(args.id) } }
        }
      }),
      ...(threadStore ? [
        LocalToolHost.defineTool({
          name: 'thread_list',
          description: 'List accessible conversation threads with their titles, status, model, and turn count. Use this before thread_read to find relevant threads.',
          inputSchema: {
            type: 'object',
            properties: {
              search: { type: 'string', description: 'Optional keyword to filter threads by title' },
              limit: { type: 'number', minimum: 1, maximum: 100, description: 'Max threads to list (default 20)' }
            },
            additionalProperties: false
          },
          policy: 'auto',
          execute: async (args) => {
            const limit = typeof args.limit === 'number' ? Math.min(100, Math.max(1, Math.floor(args.limit))) : 20
            const threads = await threadStore.list({
              includeArchived: true,
              includeSide: true,
              limit
            })
            const filtered = typeof args.search === 'string' && args.search.trim()
              ? threads.filter((t) => t.title?.toLocaleLowerCase().includes(args.search!.toLocaleLowerCase()))
              : threads
            return {
              output: {
                total: filtered.length,
                threads: filtered.slice(0, limit).map((t) => ({
                  id: t.id,
                  title: t.title || '',
                  status: t.status,
                  model: t.model,
                  mode: t.mode,
                  relation: t.relation,
                  workspace: t.workspace,
                  createdAt: t.createdAt,
                  updatedAt: t.updatedAt
                }))
              }
            }
          }
        }),
        LocalToolHost.defineTool({
          name: 'thread_read',
          description: 'Read the full conversation of a thread by its id. Returns all turns with messages, tool calls, and results. Use thread_list first to find the thread id.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Thread id to read. Use thread_list to discover available ids.' }
            },
            required: ['id'],
            additionalProperties: false
          },
          policy: 'auto',
          execute: async (args) => {
            const id = stringArg(args.id)
            if (!id) return toolError('id is required')
            const thread = await threadStore.get(id)
            if (!thread) return toolError(`thread not found: ${id}`)
            const formatted = formatThreadForAgent(thread)
            return { output: formatted }
          }
        })
      ] : [])
    ]
  }]
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArrayArg(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringArg).filter(Boolean)
    : []
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function enumArg<T extends string>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  fallback: T
): T {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : fallback
}

function toolError(message: string) {
  return { output: { error: message }, isError: true as const }
}

function formatThreadForAgent(thread: {
  id: string
  title?: string
  model?: string
  turns?: Array<{
    id: string
    status: string
    prompt: string
    model?: string
    items?: Array<{
      kind: string
      role?: string
      text?: string
      name?: string
      output?: unknown
      isError?: boolean
    }>
    createdAt?: string
    startedAt?: string
    finishedAt?: string
  }>
  createdAt?: string
  updatedAt?: string
}): Record<string, unknown> {
  const turnLogs = (thread.turns ?? []).map((turn) => {
    const messages = (turn.items ?? []).flatMap((item) => {
      const label = item.role === 'user' ? '用户' : item.role === 'assistant' ? 'AI' : ''
      if (item.kind === 'user_message' && item.text) {
        return [`[用户消息] ${item.text}`]
      }
      if (item.kind === 'assistant_text' && item.text) {
        return [`[AI回复] ${item.text}`]
      }
      if (item.kind === 'tool_call' && item.name) {
        return [`[工具调用] ${item.name}${item.text ? `: ${item.text.slice(0, 200)}` : ''}`]
      }
      if (item.kind === 'tool_result') {
        const tag = item.isError ? '工具错误' : '工具结果'
        const outputStr = typeof item.output === 'string'
          ? item.output.slice(0, 300)
          : item.output ? JSON.stringify(item.output).slice(0, 300) : ''
        return outputStr ? [`[${tag}] ${outputStr}`] : []
      }
      return []
    })
    return [
      `--- 轮次 ${turn.id.slice(0, 8)} (${turn.status}) ---`,
      `用户输入: ${turn.prompt || '(无)'}`,
      ...messages,
      turn.finishedAt ? `完成于: ${turn.finishedAt}` : ''
    ].join('\n')
  }).filter(Boolean)

  return {
    id: thread.id,
    title: thread.title || '',
    model: thread.model || '',
    createdAt: thread.createdAt || '',
    updatedAt: thread.updatedAt || '',
    turnCount: (thread.turns ?? []).length,
    conversation: turnLogs.join('\n\n')
  }
}

