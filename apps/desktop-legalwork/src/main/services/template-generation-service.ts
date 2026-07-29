/**
 * Template-Based Document Generation Service
 *
 * Generates legal documents from user templates + optional uploaded materials.
 * Unlike the simple document-generation-service, this supports:
 * - Providing reference material files
 * - Free-form user instructions
 * - Mixing pre-filled field values with AI analysis of materials
 */

import {
  resolveWriteInlineCompletionApiKey,
  resolveWriteInlineCompletionBaseUrl,
  resolveWriteInlineCompletionModel
} from '../../shared/app-settings-write'
import { upstreamOpenAiChatCompletionsUrl } from '../../shared/openai-compat-url'
import type { AppSettingsV1 } from '../../shared/app-settings-types'
import type {
  TemplateGenerateWithMaterialsRequest,
  TemplateGenerateWithMaterialsResult
} from '../../shared/user-templates'
import { legalDocumentFormatInstruction } from '../../shared/legal-document-format'

const TIMEOUT_MS = 90_000
const MAX_TOKENS = 8_192

export function buildGenerationPrompt(request: TemplateGenerateWithMaterialsRequest): {
  systemPrompt: string
  userPrompt: string
} {
  const fieldValuesText = request.template.fields
    .map((field) => {
      const value = request.fieldValues[field.id]?.trim()
      const required = field.required ? '（必填）' : ''
      return `- ${field.label}${required}：${value || '（未填写，请优先从参考材料提取；材料也没有的，使用【待核实：字段名】标注）'}`
    })
    .join('\n')

  const materialsText =
    request.materials && request.materials.length > 0
      ? request.materials
          .map(
            (m) =>
              `### 材料文件：${m.fileName}\n\`\`\`\n${m.content.slice(0, 20_000)}\n\`\`\``
          )
          .join('\n\n')
      : ''

  const instructionsText = request.instructions
    ? `\n\n用户特别要求：\n${request.instructions}`
    : ''
  const formatInstruction = legalDocumentFormatInstruction(
    request.template.id,
    request.template.name
  )

  const systemPrompt = `你是一名资深法律文书撰写专家。你的任务是根据用户选择的模板、填写的信息以及提供的参考材料，生成一份格式规范、内容严谨、说理充分的法律文书。

通用要求：
1. 严格遵循下方“本类文书格式卡”，不能把所有文书套成通用报告
2. 文书结构完整，逻辑清晰，事实陈述准确
3. 法律引用准确，说理充分
4. 按照用户选择的模板类型生成相应的文书内容
5. 使用专业、规范的法律语言
6. 将用户填写的信息和参考材料中的相关内容自然地融入文书中
7. 如果用户提供了参考材料，必须先从材料中提取当事人、案号、法院、请求、事实、证据等关键事实，再写入文书
8. 用户已填写字段的内容优先级高于参考材料；参考材料与填写字段冲突时，以用户填写字段为准，并在相应位置用【待核实：冲突信息】提示
9. 对材料或字段均未提供的信息，不得编造；确需保留的必要信息用【待核实：字段名】标注
10. 直接输出 Markdown 正文，不要包裹代码块，不要输出说明文字
11. Markdown 只是存储语法：不得使用网页文章式横线、彩色提示框、引用块、装饰性粗体或随意项目符号
12. 标题下不要重复一遍标题；文末不得添加“AI 生成”“仅供参考”等非文书内容
13. 除文种确实要求逐项列明的请求、条款、附件外，禁止把连续叙事机械拆成 1、2、3、4 的有序列表
14. 一级到四级层次必须遵循“一、”“（一）”“1.”“（1）”或该文种专用的章—条编号；同一层级不得混用

本类文书格式卡：
${formatInstruction}

仅生成该文种实际需要的组成部分。不得因为通用习惯强加“当事人信息、诉讼请求、事实与理由、此致”等不属于该文种的栏目。`

  let userPrompt = `请根据以下信息生成一份${request.template.name}。

模板说明：${request.template.description}`

  if (request.template.legalBasis && request.template.legalBasis.length > 0) {
    userPrompt += `\n\n法律依据：\n${request.template.legalBasis.map((b) => `- ${b}`).join('\n')}`
  }

  userPrompt += `\n\n字段信息：\n${fieldValuesText}`

  if (materialsText) {
    userPrompt += `\n\n参考材料（请从中提取相关信息用于文书）：\n${materialsText}`
  }

  userPrompt += `\n\n模板结构参考：\n${request.template.content.slice(0, 3000)}`

  if (instructionsText) {
    userPrompt += instructionsText
  }

  userPrompt += `\n\n请生成完整、规范的法律文书。只输出文书 Markdown 正文。`

  return { systemPrompt, userPrompt }
}

function normalizeGeneratedMarkdown(content: string): string {
  const trimmed = content.trim()
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  return (fenceMatch?.[1] ?? trimmed).trim()
}

export async function generateFromTemplate(
  settings: AppSettingsV1,
  request: TemplateGenerateWithMaterialsRequest
): Promise<TemplateGenerateWithMaterialsResult> {
  const apiKey = resolveWriteInlineCompletionApiKey(settings)
  const baseUrl = resolveWriteInlineCompletionBaseUrl(settings)
  const model = resolveWriteInlineCompletionModel(settings)

  if (!apiKey) {
    return { ok: false, message: '未配置 API Key，请在设置中填写 API 密钥。' }
  }

  const url = upstreamOpenAiChatCompletionsUrl(baseUrl)
  const { systemPrompt, userPrompt } = buildGenerationPrompt(request)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0.7,
        stream: false
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })

    const text = await response.text()

    if (!response.ok) {
      return {
        ok: false,
        message: `AI 生成请求失败 (${response.status}): ${text.slice(0, 300)}`
      }
    }

    let parsed: { choices?: Array<{ message?: { content?: string } }> }
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, message: 'AI 返回了非 JSON 数据，请重试。' }
    }

    const content = parsed?.choices?.[0]?.message?.content
    if (!content) {
      return { ok: false, message: 'AI 返回内容为空，请重试。' }
    }

    return { ok: true, content: normalizeGeneratedMarkdown(content), model }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `AI 生成失败: ${message}` }
  }
}
