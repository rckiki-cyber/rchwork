import {
  DOCUMENT_SUBJECT_FIELD_ID,
  type TemplateGenerateWithMaterialsRequest
} from '../../../../shared/user-templates'

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
    detail: '北大法宝为主来源，知识库补充观点与材料'
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

/**
 * Escape content embedded inside a ```text code fence so a stray ``` in the
 * pasted text or material cannot break out of the fence and inject raw
 * markdown/instructions into the prompt.
 */
function escapeFencedText(value: string): string {
  return value.replace(/```/g, '\\`\\`\\`')
}

function fieldsForPrompt(request: TemplateGenerateWithMaterialsRequest): string {
  return request.template.fields
    .map((field) => {
      const value = request.fieldValues[field.id]?.trim()
      return `- ${field.label}：${value || '（未填写；有材料或粘贴文字时由 Agent 主动提取，不代表该事实缺失）'}`
    })
    .join('\n')
}

function materialsForPrompt(request: TemplateGenerateWithMaterialsRequest): string {
  if (!request.materials?.length) {
    return '（用户未上传案件材料；若下方提供了粘贴文字，请同样将其视为事实来源，仅基于已填写信息与粘贴文字并明确标注待核实内容。）'
  }
  return request.materials
    .map((material) => `### ${material.fileName}\n\`\`\`text\n${escapeFencedText(material.content.slice(0, 20_000))}\n\`\`\``)
    .join('\n\n')
}

function pastedTextForPrompt(request: TemplateGenerateWithMaterialsRequest): string | null {
  const text = request.instructions?.trim()
  return text ? escapeFencedText(text.slice(0, 20_000)) : null
}

export function buildDocumentWritingAgentPrompt(request: TemplateGenerateWithMaterialsRequest): string {
  const hasMaterials = Boolean(request.materials?.length)
  const hasPastedText = Boolean(request.instructions?.trim())
  const documentSubject = request.fieldValues[DOCUMENT_SUBJECT_FIELD_ID]?.trim()
  const legalBasis = request.template.legalBasis?.length
    ? request.template.legalBasis.map((item) => `- ${item}`).join('\n')
    : '（模板未预设法律依据，需根据事实自行核验。）'
  const hasUserTemplate =
    request.template.source === 'user' ||
    request.template.id?.startsWith('custom-')
  const templatePriorityInstruction = hasUserTemplate
    ? '本任务已提供用户上传模板，属于最高优先级。必须以该模板为主，不得调用或改用隐藏内置模板；最终正文的段落、标题、表格单元格及签署区顺序应与模板逐项对应，避免随意增删结构，以便原位写回原 DOCX。'
    : '本任务没有用户上传模板。起草民事起诉状或民事答辩状时，必须先调用 resolve_legal_document_template；匹配成功则以内置模板为主，未匹配时才根据材料自主组织结构。'

  const materialFactInstruction = hasMaterials || hasPastedText
    ? `用户已提供事实来源（上传材料${hasPastedText ? '或粘贴的案情文字' : ''}）。必须先完成“事实台账”，再开始写文书：
- 材料或粘贴文字中明确载明的姓名/名称、身份、法定代表人、地址、案号、法院、案由、诉讼请求、裁判结果和日期，均属于可以直接写入文书的事实；无需等待用户再次填写，也不得仅因尚未二次核验而拒绝填写。必要时可表述为“据材料载明”。
- 对每个界面空字段，必须逐一在全部事实来源中检索同义信息；字段为空只表示用户未手工填写，不表示材料没有该事实。
- 只要事实来源中存在明确答案，就直接写入正文。严禁输出“待核实：请填写”“请补充材料”等把分析工作退回用户的提示。
- 只有全部事实来源都没有记载、无法由上下文唯一确定且该项对文书确有必要时，才可使用【待核实：具体缺失事项】；非必要的未知栏目应省略，不得成片保留模板占位语。
- 事实来源间存在实质冲突时，列明具体冲突内容并标注待核实；不得把单一来源中已明确记载的信息误判为冲突。`
    : '用户未提供任何事实来源（无上传材料、无粘贴文字）。仅对现有字段也未提供且文书确有必要的信息使用【待核实：具体缺失事项】，不要输出泛泛的“请填写”。'

  return `你正在执行 LegalWork 文书写作任务。界面已收集用户的文书类型、字段和写作要求；不要再次要求用户填写偏好。

0. 确认立场：用户指定本次文书代表的主体为“${documentSubject || '（未指定）'}”。若用户已填写，以该主体作为判断委托人、我方当事人、诉讼立场和行文视角的最高优先级依据；若用户未指定但提供了上传材料或粘贴文字，则从其中明确记载的当事人中识别本次文书所代表的一方，并以“据材料载明”表述；两者都无法确定时，才使用【待核实：我方主体】。
1. 落实用户要求：将“用户补充要求/粘贴文字”作为确定诉讼目标、表达倾向、论证重点和行文取舍的高优先级依据，不得写出与用户明确倾向相反的立场；但不得据此篡改事实、法律或材料原意。
2. 理解材料：先阅读全部材料，提取当事人、事实、时间线、证据、已知诉求与真正缺失的信息；区分裁判文书记载事实、当事人主张和确实无法确认的信息。
3. 归纳争议：列出文书必须回应的争议焦点、证明责任和需要补充的事实。
4. 选择模板：${templatePriorityInstruction}
5. 法律调研：由 Agent 根据文书与材料自主选择工具和检索路径，不要求机械调用全部来源。默认以可用的北大法宝（PKULaw）作为法规与案例主来源，并按需使用其引证核验、链接增强工具；IMA 与本地知识库作为团队先例、学术观点、写作参考和内部材料的补充来源。国家法律法规数据库仅在用户明确指定、商业库不可用/无结果或存在重大效力冲突时按需核验，不得为获取国家库链接反复重试或调用用户浏览器。
6. 研究论证：核验法律效力状态、条文、案例要旨和适用关系。保留工具返回的完整来源 URL，绝不编造法规、案例、案号、链接或事实。
7. 撰写文书：严格遵循最高优先级模板结构。信息优先级为“用户填写字段 > 材料明确记载 > 可由材料唯一确定的事实 > 真正缺失的信息”。不得把界面空字段直接转换成待核实占位语。文书中的法律依据应尽可能带可核验链接；没有真实链接时明确标注“无可核验链接”。

${materialFactInstruction}

最终回复只能输出完整的 Markdown 文书正文，不要输出过程说明、调研摘要、步骤标题或代码块。工具调用和推理会由界面单独可视化。

## 目标文书
名称：${request.template.name}
说明：${request.template.description}
模板来源：${hasUserTemplate ? '用户上传模板（最高优先级）' : '产品模板目录（若命中隐藏内置模板，应由隐藏内置模板覆盖其通用结构）'}

## 预设法律依据
${legalBasis}

## 用户填写信息
${fieldsForPrompt(request)}

## 文书涉及主体（未指定时从材料/粘贴文字中识别）
${documentSubject || '（未指定）'}

## 案件材料
${materialsForPrompt(request)}

${hasPastedText ? `## 用户粘贴的案情文字（与上传材料同样作为事实来源）
\`\`\`text
${pastedTextForPrompt(request)}
\`\`\`
` : ''}
## 模板结构参考
${request.template.content.slice(0, 3_000)}

## 用户补充要求（立场、倾向、目标与重点；必须优先落实）
${request.instructions?.trim() || '（无）'}`
}
