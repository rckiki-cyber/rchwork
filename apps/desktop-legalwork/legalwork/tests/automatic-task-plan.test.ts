import { describe, expect, it } from 'vitest'
import {
  AUTO_TASK_TODO_PREFIX,
  automaticTaskComplexity,
  buildAutomaticTaskPlan,
  completedGenericAutomaticTaskPlan,
  reconcileAutomaticTaskTodos
} from '../src/loop/automatic-task-plan.js'

const emptySignals = {
  requestedArtifacts: [] as string[],
  completedArtifacts: new Set<string>(),
  localKnowledgeRequested: false,
  localKnowledgeSatisfied: false,
  imaKnowledgeRequested: false,
  imaKnowledgeSatisfied: false,
  requiredKnowledgePdfReads: 0,
  completedKnowledgePdfReads: 0,
  caseResearchRequested: false,
  caseResearchSatisfied: false,
  desensitizationRequired: false,
  desensitizationSatisfied: false,
  citationVerificationRequested: false,
  citationVerificationSatisfied: false,
  evidenceBarrierActive: false
}

describe('automatic task plan', () => {
  it('detects multi-stage, multi-artifact long tasks and builds runtime gates', () => {
    const prompt = [
      '请严格依次完成全部阶段并完整交付。'.repeat(20),
      '### 阶段一：本地知识库深度调研',
      '### 阶段二：OCR 提取至少 3 篇 PDF',
      '### 阶段三：引用核验',
      '### 阶段四：交付文件',
      '撰写不少于 15000 字的报告，生成 Word、PDF、PPT。'
    ].join('\n')
    expect(automaticTaskComplexity(prompt, 3).score).toBeGreaterThanOrEqual(4)

    const plan = buildAutomaticTaskPlan({
      prompt,
      signals: {
        ...emptySignals,
        requestedArtifacts: ['docx', 'pdf', 'pptx'],
        localKnowledgeRequested: true,
        requiredKnowledgePdfReads: 3,
        completedKnowledgePdfReads: 1,
        citationVerificationRequested: true
      }
    })

    expect(plan?.runtimeManaged).toBe(true)
    expect(plan?.stages.map((stage) => stage.key)).toEqual(expect.arrayContaining([
      'local-evidence',
      'pdf-reading',
      'verified-draft',
      'artifact-docx',
      'artifact-pdf',
      'artifact-pptx',
      'final-acceptance'
    ]))
    expect(plan?.stages.find((stage) => stage.key === 'final-acceptance')?.completed).toBe(false)
  })

  it('persists one active stage, advances deterministically, and preserves manual todos', () => {
    const prompt = [
      '### 阶段一：调研',
      '### 阶段二：分析',
      '### 阶段三：验证',
      '全部完成后交付。'
    ].join('\n')
    const plan = buildAutomaticTaskPlan({ prompt, signals: emptySignals })
    if (!plan) throw new Error('expected automatic plan')
    const first = reconcileAutomaticTaskTodos({
      threadId: 'thread_1',
      turnId: 'turn_1',
      current: undefined,
      plan,
      now: '2026-08-09T00:00:00.000Z'
    })
    expect(first?.changed).toBe(true)
    expect(first?.todos.items.filter((item) => item.status === 'in_progress')).toHaveLength(1)
    expect(first?.todos.items.every((item) => item.id.startsWith(AUTO_TASK_TODO_PREFIX))).toBe(true)

    const completed = reconcileAutomaticTaskTodos({
      threadId: 'thread_1',
      turnId: 'turn_1',
      current: first?.todos,
      plan: completedGenericAutomaticTaskPlan(plan),
      now: '2026-08-09T00:01:00.000Z'
    })
    expect(completed?.todos.items.every((item) => item.status === 'completed')).toBe(true)

    expect(reconcileAutomaticTaskTodos({
      threadId: 'thread_1',
      turnId: 'turn_1',
      current: {
        threadId: 'thread_1',
        updatedAt: '2026-08-09T00:00:00.000Z',
        items: [{
          id: 'manual_1',
          content: '用户手工任务',
          status: 'in_progress',
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z'
        }]
      },
      plan,
      now: '2026-08-09T00:01:00.000Z'
    })).toBeUndefined()
  })
})
