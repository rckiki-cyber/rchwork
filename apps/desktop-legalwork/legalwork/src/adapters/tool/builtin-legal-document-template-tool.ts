import type { LocalTool } from './local-tool-host.js'
import {
  EMBEDDED_LEGAL_DOCUMENT_CAUSES,
  resolveEmbeddedLegalDocumentTemplate,
  type EmbeddedDocumentType
} from '../../templates/embedded-legal-document-templates.js'

export const RESOLVE_LEGAL_DOCUMENT_TEMPLATE_TOOL_NAME = 'resolve_legal_document_template'

function normalizeDocumentType(value: unknown): EmbeddedDocumentType | null {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'complaint' || normalized.includes('起诉')) return 'complaint'
  if (normalized === 'answer' || normalized.includes('答辩')) return 'answer'
  return null
}

export function createResolveLegalDocumentTemplateTool(): LocalTool {
  return {
    name: RESOLVE_LEGAL_DOCUMENT_TEMPLATE_TOOL_NAME,
    description:
      'Resolve a hidden built-in legal document template by document type and case context. ' +
      'Use this before autonomously drafting a civil complaint or civil answer when the user has not supplied or selected a custom template. ' +
      'A user-uploaded or explicitly supplied custom template always has higher priority and must not be overridden. ' +
      'If a matching embedded template is returned, follow its structure before creating a structure from scratch.',
    toolKind: 'tool_call',
    inputSchema: {
      type: 'object',
      properties: {
        documentType: {
          type: 'string',
          enum: ['complaint', 'answer'],
          description: 'Use complaint for 民事起诉状 and answer for 民事答辩状.'
        },
        query: {
          type: 'string',
          description:
            'Case cause and concise task context. Include the exact or likely案由, such as 民间借贷纠纷、物业服务合同纠纷.'
        }
      },
      required: ['documentType', 'query'],
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args) => {
      const documentType = normalizeDocumentType(args.documentType)
      if (!documentType) {
        return {
          output: {
            matched: false,
            reason: 'documentType 必须为 complaint 或 answer'
          },
          isError: true
        }
      }

      const query = String(args.query ?? '').trim().slice(0, 4_000)
      const template = resolveEmbeddedLegalDocumentTemplate({ query, documentType })
      if (!template) {
        return {
          output: {
            matched: false,
            reason: '未匹配到内置模板，可根据材料自主生成结构。',
            supportedCauses: EMBEDDED_LEGAL_DOCUMENT_CAUSES
          }
        }
      }

      return {
        output: {
          matched: true,
          priority: 'embedded-after-user-template',
          template: {
            id: template.id,
            name: template.name,
            cause: template.cause,
            documentType: template.documentType,
            content: template.content
          },
          instruction:
            '仅在当前任务没有用户上传或明确提供的自定义模板时使用；按模板项目顺序起草，材料缺失处使用【待核实：…】。'
        }
      }
    }
  }
}
