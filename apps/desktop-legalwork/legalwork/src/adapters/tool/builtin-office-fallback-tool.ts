import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import {
  consumeOfficeFallbackEligibility,
  grantOfficeFallback,
  isLegalDocumentFormattingActive
} from './office-fallback-policy.js'

export const REQUEST_OFFICE_FALLBACK_TOOL_NAME = 'request_office_fallback'
export const DOCUMENT_UNSUPPORTED_MARKER = 'LEGALWORK_DOCUMENT_UNSUPPORTED'

export function createRequestOfficeFallbackTool(): LocalTool {
  return LocalToolHost.defineTool({
    name: REQUEST_OFFICE_FALLBACK_TOOL_NAME,
    description:
      'Unlock Office MCP for the current turn only after LegalWork\'s trusted document_skill_execute tool recorded a genuine structural limitation. Model-created tickets/files cannot unlock it.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    },
    policy: 'auto',
    toolKind: 'tool_call',
    shouldAdvertise: (context) => isLegalDocumentFormattingActive(context),
    execute: async (_args, context) => {
      const evidence = consumeOfficeFallbackEligibility(context)
      if (!evidence) {
        return {
          output: {
            error: 'Office fallback is not eligible for this turn.',
            note: 'Use document_skill_execute and exhaust safe local Skill methods first. Environment, dependency, argument, file-type, and ordinary formatting errors never unlock Office MCP.'
          },
          isError: true
        }
      }
      grantOfficeFallback(context)
      return {
        output: {
          granted: true,
          scope: 'turn',
          reason: evidence.reason,
          operation: evidence.operation,
          note: 'Office MCP is now available only for this turn as a last-resort fallback. Use the minimum necessary calls.'
        }
      }
    }
  })
}
