import { z } from 'zod'

export const MemoryScope = z.enum(['user', 'workspace', 'project'])
export type MemoryScope = z.infer<typeof MemoryScope>

export const MemoryCategory = z.enum([
  'profile',
  'preference',
  'workflow',
  'project',
  'interest',
  'matter',
  'other'
])
export type MemoryCategory = z.infer<typeof MemoryCategory>

export const MemoryRecallPolicy = z.enum(['always', 'relevant'])
export type MemoryRecallPolicy = z.infer<typeof MemoryRecallPolicy>

export const MemoryCaptureSource = z.enum([
  'automatic',
  'explicit',
  'confirmed',
  'manual',
  'legacy'
])
export type MemoryCaptureSource = z.infer<typeof MemoryCaptureSource>

export const MemoryRecordState = z.enum(['active', 'disabled', 'deleted'])
export type MemoryRecordState = z.infer<typeof MemoryRecordState>

export const MemoryOrigin = z.enum(['manual', 'agent', 'learning-iteration', 'legacy'])
export type MemoryOrigin = z.infer<typeof MemoryOrigin>

export const MemoryEvidence = z.object({
  sourceKey: z.string().min(1),
  note: z.string().optional()
}).strict()
export type MemoryEvidence = z.infer<typeof MemoryEvidence>

export const MemoryRecord = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  scope: MemoryScope,
  category: MemoryCategory.default('other'),
  recallPolicy: MemoryRecallPolicy.default('relevant'),
  captureSource: MemoryCaptureSource.default('legacy'),
  workspace: z.string().optional(),
  project: z.string().optional(),
  sourceThreadId: z.string().optional(),
  sourceTurnId: z.string().optional(),
  origin: MemoryOrigin.default('legacy'),
  sourceIterationId: z.string().optional(),
  evidence: z.array(MemoryEvidence).default([]),
  tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  disabledAt: z.string().optional(),
  deletedAt: z.string().optional()
}).strict()
export type MemoryRecord = z.infer<typeof MemoryRecord>

export const MemoryCreateRequest = z.object({
  content: z.string().min(1),
  scope: MemoryScope.default('workspace'),
  category: MemoryCategory.default('other'),
  recallPolicy: MemoryRecallPolicy.default('relevant'),
  captureSource: MemoryCaptureSource.exclude(['legacy']).default('manual'),
  workspace: z.string().optional(),
  project: z.string().optional(),
  sourceThreadId: z.string().optional(),
  sourceTurnId: z.string().optional(),
  origin: MemoryOrigin.exclude(['legacy']).default('manual'),
  sourceIterationId: z.string().optional(),
  evidence: z.array(MemoryEvidence).default([]),
  tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(1)
}).strict()
export type MemoryCreateRequest = z.input<typeof MemoryCreateRequest>

export const MemoryUpdateRequest = z.object({
  content: z.string().min(1).optional(),
  scope: MemoryScope.optional(),
  category: MemoryCategory.optional(),
  recallPolicy: MemoryRecallPolicy.optional(),
  workspace: z.string().optional(),
  project: z.string().optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  disabled: z.boolean().optional(),
  restore: z.literal(true).optional()
}).strict()
export type MemoryUpdateRequest = z.input<typeof MemoryUpdateRequest>

export type MemoryListFilter = {
  workspace?: string
  project?: string
  includeDeleted?: boolean
  query?: string
  scope?: MemoryScope
  category?: MemoryCategory
  state?: MemoryRecordState
  limit?: number
  offset?: number
}

export type MemoryListResult = {
  memories: MemoryRecord[]
  total: number
}

export const MemoryDiagnostics = z.object({
  enabled: z.boolean(),
  rootDir: z.string(),
  activeCount: z.number().int().nonnegative(),
  tombstoneCount: z.number().int().nonnegative(),
  lastInjectedIds: z.array(z.string()).default([])
}).strict()
export type MemoryDiagnostics = z.infer<typeof MemoryDiagnostics>
