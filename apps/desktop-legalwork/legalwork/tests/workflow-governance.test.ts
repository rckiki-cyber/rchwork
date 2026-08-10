import { describe, expect, it } from 'vitest'
import {
  evaluateWorkflowAcceptance,
  selectWorkflowAction,
  workflowAcceptanceInstruction,
  workflowActionInstruction,
  workflowAttemptLimit
} from '../src/loop/workflow-governance.js'

describe('workflow governance', () => {
  it('selects the first ready category in dependency order', () => {
    const selected = selectWorkflowAction([
      { key: 'evidence.local', lane: 'evidence', toolName: 'knowledge_search', ready: false, reason: 'done' },
      { key: 'artifact.docx', lane: 'document-delivery', toolName: 'document_skill_execute', ready: true, reason: 'pending' },
      { key: 'compliance.desensitize', lane: 'compliance', toolName: 'data_compliance', ready: true, reason: 'required' }
    ])

    expect(selected).toMatchObject({
      key: 'compliance.desensitize',
      lane: 'compliance',
      toolName: 'data_compliance',
      attemptLimit: 2
    })
  })

  it('centralizes bounded retry budgets by workflow category', () => {
    expect(workflowAttemptLimit('validation')).toBe(2)
    expect(workflowAttemptLimit('document-delivery')).toBe(3)
    expect(workflowAttemptLimit('presentation-delivery')).toBe(3)
    expect(workflowAttemptLimit('final-acceptance')).toBe(1)
  })

  it('emits a category-level instruction that forbids cross-lane fallback', () => {
    const selected = selectWorkflowAction([
      { key: 'artifact.pptx', lane: 'presentation-delivery', toolName: 'bash', ready: true, reason: 'PPT pending' }
    ])
    expect(selected).toBeDefined()
    expect(workflowActionInstruction(selected!)).toContain('不得改用当前类别之外的工具绕过')
  })

  it('keeps final acceptance runtime-owned across all required categories', () => {
    const blocked = evaluateWorkflowAcceptance({
      requiredKeys: ['evidence.local', 'artifact.docx', 'artifact.pptx'],
      completedKeys: new Set(['evidence.local', 'artifact.docx']),
      blockerReasons: ['PPT 风格验收未通过']
    })
    expect(blocked.accepted).toBe(false)
    expect(blocked.missingKeys).toEqual(['artifact.pptx'])
    expect(workflowAcceptanceInstruction(blocked)).toContain('不得声明任务完成')

    const accepted = evaluateWorkflowAcceptance({
      requiredKeys: blocked.requiredKeys,
      completedKeys: new Set(blocked.requiredKeys)
    })
    expect(accepted.accepted).toBe(true)
    expect(workflowAcceptanceInstruction(accepted)).toContain('最终验收已通过')
  })
})
