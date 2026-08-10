import type { LocalTool } from './local-tool-host.js'
import {
  FACT_VERIFICATION_FINALIZE_TOOL_NAME,
  validateFactVerificationLedger
} from '../../loop/fact-verification.js'

export function createFactVerificationFinalizeTool(): LocalTool {
  return {
    name: FACT_VERIFICATION_FINALIZE_TOOL_NAME,
    description: 'Finalize a fact-checking task as a structured claim-by-claim evidence ledger. Every non-unverified conclusion needs source titles and URLs actually returned by prior research tools.',
    inputSchema: {
      type: 'object',
      properties: {
        claims: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              statement: { type: 'string' },
              verdict: { type: 'string', enum: ['verified', 'contradicted', 'mixed', 'unverified'] },
              rationale: { type: 'string' },
              evidence: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    url: { type: 'string' },
                    support: { type: 'string' }
                  },
                  required: ['title', 'url'],
                  additionalProperties: false
                }
              }
            },
            required: ['statement', 'verdict', 'rationale', 'evidence'],
            additionalProperties: false
          }
        },
        unresolved: { type: 'array', items: { type: 'string' } }
      },
      required: ['claims'],
      additionalProperties: false
    },
    toolKind: 'tool_call',
    policy: 'auto',
    execute: async (args) => {
      const validated = validateFactVerificationLedger(args)
      if (!validated.ok) {
        return { output: { verificationPassed: false, error: validated.error }, isError: true }
      }
      return {
        output: {
          verificationPassed: true,
          claimCount: validated.claims.length,
          sourceCount: validated.sourceUrls.length,
          sourceUrls: validated.sourceUrls,
          claims: validated.claims,
          unresolved: Array.isArray(args.unresolved) ? args.unresolved : []
        }
      }
    }
  }
}
