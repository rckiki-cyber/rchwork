import type { ThreadTodoList } from '../contracts/threads.js'

export const AUTO_TASK_TODO_PREFIX = 'todo_auto_task_'

export type AutomaticTaskPlanSignals = {
  requestedArtifacts: readonly string[]
  completedArtifacts: ReadonlySet<string>
  localKnowledgeRequested: boolean
  localKnowledgeSatisfied: boolean
  imaKnowledgeRequested: boolean
  imaKnowledgeSatisfied: boolean
  requiredKnowledgePdfReads: number
  completedKnowledgePdfReads: number
  caseResearchRequested: boolean
  caseResearchSatisfied: boolean
  desensitizationRequired: boolean
  desensitizationSatisfied: boolean
  citationVerificationRequested: boolean
  citationVerificationSatisfied: boolean
  factVerificationRequested?: boolean
  factWebEvidenceSatisfied?: boolean
  factLegalEvidenceRequired?: boolean
  factLegalEvidenceSatisfied?: boolean
  factLedgerSatisfied?: boolean
  evidenceBarrierActive: boolean
}

export type AutomaticTaskPlanStage = {
  key: string
  content: string
  completed: boolean
}

export type AutomaticTaskPlan = {
  complexityScore: number
  reasons: string[]
  stages: AutomaticTaskPlanStage[]
  runtimeManaged: boolean
  genericTextCompletion: boolean
}

function explicitStageNames(prompt: string): string[] {
  const names: string[] = []
  for (const line of prompt.split(/\r?\n/)) {
    const match = line.match(/^\s*#{1,6}\s*(?:阶段\s*[一二三四五六七八九十\d]+[：:]?\s*)?(.+?)\s*$/)
    const name = match?.[1]?.trim()
    if (!name || !/(?:阶段|步骤|调研|研究|分析|审查|撰写|制作|交付|验证|测试|部署|实现)/.test(line)) {
      continue
    }
    if (!names.includes(name)) names.push(name)
    if (names.length >= 12) break
  }
  return names
}

export function automaticTaskComplexity(prompt: string, artifactCount = 0): {
  score: number
  reasons: string[]
} {
  const reasons: string[] = []
  let score = 0
  const stages = explicitStageNames(prompt)
  if (prompt.length >= 400) {
    score += 2
    reasons.push('长指令')
  }
  if (stages.length >= 3) {
    score += 3
    reasons.push(`${stages.length} 个显式阶段`)
  } else if (stages.length > 0) {
    score += 1
    reasons.push('分阶段要求')
  }
  if (artifactCount >= 2) {
    score += 2
    reasons.push(`${artifactCount} 种交付物`)
  }
  const requestedLength = Number.parseInt(
    prompt.match(/(?:不少于|至少|不低于)\s*([\d,，]+)\s*(?:个)?\s*(?:中文)?\s*字/)?.[1]?.replace(/[,，]/g, '') ?? '0',
    10
  )
  if (requestedLength >= 3_000) {
    score += 2
    reasons.push(`长篇正文 ${requestedLength} 字`)
  }
  if (/(?:本地知识库|IMA|元典|北大法宝|多源).{0,30}(?:检索|调研|研究)|(?:检索|调研|研究).{0,30}(?:本地知识库|IMA|元典|北大法宝|多源)/is.test(prompt)) {
    score += 1
    reasons.push('多源研究')
  }
  if (/(?:OCR|脱敏|引用核验|参考文献|典型案例|测试|验证|审查)/i.test(prompt)) {
    score += 1
    reasons.push('强制验证步骤')
  }
  if (/(?:依次|逐步|全部完成|不得遗漏|实际生成成功|完整交付)/.test(prompt)) {
    score += 1
    reasons.push('完整性约束')
  }
  return { score, reasons }
}

export function buildAutomaticTaskPlan(input: {
  prompt: string
  signals: AutomaticTaskPlanSignals
}): AutomaticTaskPlan | undefined {
  const { prompt, signals } = input
  const complexity = automaticTaskComplexity(prompt, signals.requestedArtifacts.length)
  if (complexity.score < 4) return undefined

  const stages: AutomaticTaskPlanStage[] = [{
    key: 'requirements',
    content: '解析任务阶段、强制要求和最终验收条件',
    completed: true
  }]
  if (signals.localKnowledgeRequested) {
    stages.push({
      key: 'local-evidence',
      content: '检索本地知识库并取得可引用的正文证据',
      completed: signals.localKnowledgeSatisfied
    })
  }
  if (signals.requiredKnowledgePdfReads > 0) {
    stages.push({
      key: 'pdf-reading',
      content: `逐篇读取/OCR 至少 ${signals.requiredKnowledgePdfReads} 篇不同 PDF`,
      completed: signals.completedKnowledgePdfReads >= signals.requiredKnowledgePdfReads
    })
  }
  if (signals.imaKnowledgeRequested) {
    stages.push({
      key: 'ima-evidence',
      content: '完成 IMA 知识库补充研究并保留来源证据',
      completed: signals.imaKnowledgeSatisfied
    })
  }
  if (signals.factVerificationRequested) {
    stages.push({
      key: 'fact-web-evidence',
      content: '检索并实际读取不同网页来源，核实事实、新闻与数据陈述',
      completed: signals.factWebEvidenceSatisfied === true
    })
    if (signals.factLegalEvidenceRequired) {
      stages.push({
        key: 'fact-legal-evidence',
        content: '核对规范名称、条文、发布机关、日期和现行效力',
        completed: signals.factLegalEvidenceSatisfied === true
      })
    }
    stages.push({
      key: 'fact-ledger',
      content: '完成逐项结论、理由与来源可追溯的事实核验账本',
      completed: signals.factLedgerSatisfied === true
    })
  }
  if (signals.caseResearchRequested) {
    stages.push({
      key: 'case-evidence',
      content: '检索并核实用户要求数量的案例、案号、法院与裁判来源',
      completed: signals.caseResearchSatisfied
    })
  }
  if (signals.desensitizationRequired) {
    stages.push({
      key: 'desensitization',
      content: '执行真实脱敏并将脱敏策略与成果纳入交付内容',
      completed: signals.desensitizationSatisfied
    })
  }
  if (signals.citationVerificationRequested) {
    stages.push({
      key: 'verified-draft',
      content: '完成全部正文并通过真实来源引用核验',
      completed: signals.citationVerificationSatisfied
    })
  }
  for (const artifact of signals.requestedArtifacts) {
    stages.push({
      key: `artifact-${artifact}`,
      content: `生成并验收 ${artifact.toUpperCase()} 交付文件`,
      completed: signals.completedArtifacts.has(artifact)
    })
  }

  const hasRuntimeGates = stages.length > 1
  if (!hasRuntimeGates) {
    const explicit = explicitStageNames(prompt)
    for (const [index, name] of explicit.entries()) {
      stages.push({
        key: `explicit-${index}`,
        content: name,
        completed: false
      })
    }
    if (explicit.length === 0) {
      stages.push({
        key: 'execution',
        content: '按依赖顺序完成研究、分析、实现和验证',
        completed: false
      })
    }
  }

  const substantiveStages = stages.filter((stage) => stage.key !== 'requirements')
  const allSubstantiveComplete = substantiveStages.length > 0 &&
    substantiveStages.every((stage) => stage.completed)
  stages.push({
    key: 'final-acceptance',
    content: '逐项复核要求与产物，确认无遗漏后完整交付',
    completed: allSubstantiveComplete && !signals.evidenceBarrierActive
  })

  return {
    complexityScore: complexity.score,
    reasons: complexity.reasons,
    stages,
    runtimeManaged: hasRuntimeGates,
    genericTextCompletion: !hasRuntimeGates
  }
}

export function automaticTaskPlanInstruction(plan: AutomaticTaskPlan): string {
  const firstIncomplete = plan.stages.find((stage) => !stage.completed)
  const progressionRule = plan.runtimeManaged
    ? '- 只推进当前 in_progress 阶段；已完成阶段不得重复检索或重做。运行时会在工具/产物验收后自动解锁下一阶段。'
    : '- 在本次执行中按顺序完成 in_progress 与后续 pending 阶段；输出前逐项自检，不得只完成第一步便收尾。'
  return [
    '<automatic_task_plan>',
    `运行时已识别复杂任务（${plan.reasons.join('、')}），并建立持久化执行计划。`,
    ...plan.stages.map((stage) => `- [${stage.completed ? 'completed' : stage === firstIncomplete ? 'in_progress' : 'pending'}] ${stage.content}`),
    '',
    '执行规则：',
    progressionRule,
    '- 工具失败时修复当前失败点，不得转去用 shell 翻查会话历史或绕过验收。',
    '- 长正文、引用核验稿和文件生成必须复用运行时保存的规范版本，不得重新凭记忆改写。',
    '- 所有明确要求的交付物实际生成并验收前，不得输出完成声明。',
    '- 此计划由运行时自动维护，不要调用 todo_write 覆盖它。',
    '</automatic_task_plan>'
  ].join('\n')
}

export function reconcileAutomaticTaskTodos(input: {
  threadId: string
  turnId: string
  current: ThreadTodoList | undefined
  plan: AutomaticTaskPlan
  now: string
}): { todos: ThreadTodoList; changed: boolean } | undefined {
  const currentItems = input.current?.items ?? []
  if (currentItems.some((item) => !item.id.startsWith(AUTO_TASK_TODO_PREFIX))) {
    return undefined
  }
  const firstIncomplete = input.plan.stages.find((stage) => !stage.completed)
  const previousById = new Map(currentItems.map((item) => [item.id, item]))
  const items = input.plan.stages.map((stage) => {
    const id = `${AUTO_TASK_TODO_PREFIX}${input.turnId}_${stage.key}`
    const previous = previousById.get(id)
    const status = stage.completed
      ? 'completed' as const
      : stage === firstIncomplete
        ? 'in_progress' as const
        : 'pending' as const
    const unchanged = previous?.content === stage.content && previous.status === status
    return {
      id,
      content: stage.content,
      status,
      createdAt: previous?.createdAt ?? input.now,
      updatedAt: unchanged ? previous.updatedAt : input.now
    }
  })
  const changed = items.length !== currentItems.length || items.some((item, index) => {
    const current = currentItems[index]
    return !current || current.id !== item.id || current.content !== item.content || current.status !== item.status
  })
  return {
    todos: { threadId: input.threadId, items, updatedAt: changed ? input.now : input.current?.updatedAt ?? input.now },
    changed
  }
}

export function completedGenericAutomaticTaskPlan(plan: AutomaticTaskPlan): AutomaticTaskPlan {
  if (!plan.genericTextCompletion) return plan
  return {
    ...plan,
    stages: plan.stages.map((stage) => ({ ...stage, completed: true }))
  }
}
