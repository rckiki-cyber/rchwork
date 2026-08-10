export type WorkflowLane =
  | 'planning'
  | 'evidence'
  | 'extraction'
  | 'compliance'
  | 'validation'
  | 'document-delivery'
  | 'presentation-delivery'
  | 'final-acceptance'

export type WorkflowActionCandidate = {
  key: string
  lane: WorkflowLane
  toolName?: string
  ready: boolean
  reason: string
}

export type SelectedWorkflowAction = {
  key: string
  lane: WorkflowLane
  toolName: string
  reason: string
  attemptLimit: number
}

export type WorkflowAcceptance = {
  accepted: boolean
  requiredKeys: string[]
  completedKeys: string[]
  missingKeys: string[]
  blockerReasons: string[]
}

const ATTEMPT_LIMITS: Record<WorkflowLane, number> = {
  planning: 3,
  evidence: 2,
  extraction: 3,
  compliance: 2,
  validation: 2,
  'document-delivery': 3,
  'presentation-delivery': 3,
  'final-acceptance': 1
}

const LANE_ORDER: Record<WorkflowLane, number> = {
  planning: 0,
  evidence: 10,
  extraction: 20,
  compliance: 30,
  validation: 40,
  'document-delivery': 50,
  'presentation-delivery': 60,
  'final-acceptance': 70
}

/**
 * Select exactly one executable workflow action in dependency order.
 *
 * AgentLoop computes facts (evidence available, artifact complete, etc.);
 * this policy owns category ordering and attempt budgets. Keeping the two
 * separate prevents a single product-specific condition from silently
 * reordering the whole long-task workflow.
 */
export function selectWorkflowAction(
  candidates: readonly WorkflowActionCandidate[]
): SelectedWorkflowAction | undefined {
  const selected = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) =>
      candidate.ready && typeof candidate.toolName === 'string' && candidate.toolName.length > 0
    )
    .sort((left, right) =>
      LANE_ORDER[left.candidate.lane] - LANE_ORDER[right.candidate.lane] ||
      left.index - right.index
    )[0]?.candidate
  if (!selected?.toolName) return undefined
  return {
    key: selected.key,
    lane: selected.lane,
    toolName: selected.toolName,
    reason: selected.reason,
    attemptLimit: workflowAttemptLimit(selected.lane)
  }
}

export function workflowAttemptLimit(lane: WorkflowLane): number {
  return ATTEMPT_LIMITS[lane]
}

export function workflowActionInstruction(action: SelectedWorkflowAction): string {
  return [
    '<workflow_governance>',
    `当前类别：${action.lane}；当前动作：${action.key}。`,
    `本轮只执行 ${action.toolName}：${action.reason}`,
    `本类别最多允许 ${action.attemptLimit} 次有效尝试；相同成功调用不得重复，失败后必须修正参数或内容。`,
    '完成当前动作后由运行时重新计算下一类别；不得自行回退到已完成类别，不得改用当前类别之外的工具绕过。',
    '</workflow_governance>'
  ].join('\n')
}

export function evaluateWorkflowAcceptance(input: {
  requiredKeys: readonly string[]
  completedKeys: ReadonlySet<string>
  blockerReasons?: readonly string[]
}): WorkflowAcceptance {
  const requiredKeys = [...new Set(input.requiredKeys)]
  const completedKeys = requiredKeys.filter((key) => input.completedKeys.has(key))
  const missingKeys = requiredKeys.filter((key) => !input.completedKeys.has(key))
  const blockerReasons = [...new Set(
    (input.blockerReasons ?? []).map((reason) => reason.trim()).filter(Boolean)
  )]
  return {
    accepted: missingKeys.length === 0 && blockerReasons.length === 0,
    requiredKeys,
    completedKeys,
    missingKeys,
    blockerReasons
  }
}

export function workflowAcceptanceInstruction(acceptance: WorkflowAcceptance): string {
  if (acceptance.accepted) {
    return [
      '<workflow_final_acceptance>',
      `运行时最终验收已通过：${acceptance.completedKeys.join('、') || '无强制工具阶段'}。`,
      '只汇报已经验收的成果和实际交付路径，不得重复执行已完成阶段。',
      '</workflow_final_acceptance>'
    ].join('\n')
  }
  return [
    '<workflow_final_acceptance>',
    `运行时最终验收未通过；缺少：${acceptance.missingKeys.join('、') || '无'}。`,
    ...(acceptance.blockerReasons.length
      ? [`阻塞原因：${acceptance.blockerReasons.join('；')}`]
      : []),
    '不得声明任务完成。',
    '</workflow_final_acceptance>'
  ].join('\n')
}
