import type { TemplateGenerateWithMaterialsRequest } from '../../../../shared/user-templates'

export type DocumentWritingStageId =
  | 'materials'
  | 'issues'
  | 'research'
  | 'analysis'
  | 'drafting'

export type DocumentWritingStageStatus = 'pending' | 'running' | 'done' | 'error'

export type DocumentWritingStage = {
  id: DocumentWritingStageId
  label: string
  detail: string
  status: DocumentWritingStageStatus
}

const STAGE_COPY: Record<DocumentWritingStageId, Omit<DocumentWritingStage, 'status'>> = {
  materials: {
    id: 'materials',
    label: '理解材料',
    detail: '提取当事人、事实、证据和时间线'
  },
  issues: {
    id: 'issues',
    label: '归纳争议',
    detail: '识别待解决的问题和证明要点'
  },
  research: {
    id: 'research',
    label: '法律调研',
    detail: '检索知识库、北大法宝、元典及官方来源'
  },
  analysis: {
    id: 'analysis',
    label: '研究论证',
    detail: '核验依据并组织适用关系'
  },
  drafting: {
    id: 'drafting',
    label: '撰写文书',
    detail: '按模板生成可编辑的文书正文'
  }
}

export function createDocumentWritingStages(materialCount: number): DocumentWritingStage[] {
  return (Object.keys(STAGE_COPY) as DocumentWritingStageId[]).map((id) => ({
    ...STAGE_COPY[id],
    detail: id === 'materials' && materialCount > 0
      ? `正在理解 ${materialCount} 份案件材料`
      : STAGE_COPY[id].detail,
    status: id === 'materials' ? 'running' : 'pending'
  }))
}

export function updateDocumentWritingStages(
  stages: DocumentWritingStage[],
  stageId: DocumentWritingStageId,
  status: DocumentWritingStageStatus,
  detail?: string
): DocumentWritingStage[] {
  return stages.map((stage) =>
    stage.id === stageId ? { ...stage, status, detail: detail ?? stage.detail } : stage
  )
}

export function advanceDocumentWritingStage(
  stages: DocumentWritingStage[],
  activeStageId: DocumentWritingStageId,
  detail?: string
): DocumentWritingStage[] {
  const index = stages.findIndex((stage) => stage.id === activeStageId)
  return stages.map((stage, stageIndex) => {
    if (stageIndex < index) return stage.status === 'error' ? stage : { ...stage, status: 'done' }
    if (stageIndex === index) return { ...stage, status: 'running', detail: detail ?? stage.detail }
    return stage
  })
}

export function completeDocumentWritingStages(stages: DocumentWritingStage[]): DocumentWritingStage[] {
  return stages.map((stage) =>
    stage.status === 'error' ? stage : { ...stage, status: 'done' }
  )
}

export function documentWritingStageForTool(summary: string, toolName?: string): DocumentWritingStageId {
  const text = `${toolName ?? ''} ${summary}`.toLowerCase()
  if (text.includes('knowledge') || text.includes('read') || text.includes('file')) return 'materials'
  if (text.includes('pkulaw') || text.includes('元典') || text.includes('yuandian') || text.includes('law') || text.includes('case') || text.includes('web') || text.includes('search') || text.includes('法规') || text.includes('检索')) return 'research'
  return 'analysis'
}

function fieldsForPrompt(request: TemplateGenerateWithMaterialsRequest): string {
  return request.template.fields
    .map((field) => {
      const value = request.fieldValues[field.id]?.trim()
      return `- ${field.label}${field.required ? '（必填）' : ''}：${value || '（未填写）'}`
    })
    .join('\n')
}

function materialsForPrompt(request: TemplateGenerateWithMaterialsRequest): string {
  if (!request.materials?.length) return '（用户尚未上传案件材料，请仅基于已填写信息并明确标注待核实内容。）'
  return request.materials
    .map((material) => `### ${material.fileName}\n\`\`\`text\n${material.content.slice(0, 20_000)}\n\`\`\``)
    .join('\n\n')
}

export function buildDocumentWritingAgentPrompt(request: TemplateGenerateWithMaterialsRequest): string {
  const legalBasis = request.template.legalBasis?.length
    ? request.template.legalBasis.map((item) => `- ${item}`).join('\n')
    : '（模板未预设法律依据，需根据事实自行核验。）'

  return `你正在执行 LegalWork 文书写作任务。界面已收集用户的文书类型、字段和写作要求；不要再次要求用户填写偏好。必须按以下顺序完成，不能跳过调研直接起草：

1. 理解材料：先阅读全部材料，提取当事人、事实、时间线、证据、已知诉求与缺失信息；区分已证实事实、当事人主张和待核实信息。
2. 归纳争议：列出文书必须回应的争议焦点、证明责任和需要补充的事实。
3. 法律调研：先调用可用的知识库工具寻找团队模板、先例和写作参考；再主动调用可用的北大法宝（PKULaw）、元典以及其他已配置法律法规/案例工具。若某一来源不可用或失败，继续用国家法律法规数据库或其他可用权威来源完成核验，不能因单个工具失败而停止。
4. 研究论证：核验法律效力状态、条文、案例要旨和适用关系。保留工具返回的完整来源 URL，绝不编造法规、案例、案号、链接或事实。
5. 撰写文书：严格遵循模板结构，以用户填写字段优先；冲突或缺失的信息必须以【待核实：…】标注。文书中的法律依据应尽可能带可核验链接；没有真实链接时明确标注“无可核验链接”。

最终回复只能输出完整的 Markdown 文书正文，不要输出过程说明、调研摘要、步骤标题或代码块。工具调用和推理会由界面单独可视化。

## 目标文书
名称：${request.template.name}
说明：${request.template.description}

## 预设法律依据
${legalBasis}

## 用户填写信息
${fieldsForPrompt(request)}

## 案件材料
${materialsForPrompt(request)}

## 模板结构参考
${request.template.content.slice(0, 3_000)}

## 用户特别要求
${request.instructions?.trim() || '（无）'}`
}
