import { readFile, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import {
  grantOfficeFallback,
  isLegalDocumentFormattingActive
} from './office-fallback-policy.js'

export const REQUEST_OFFICE_FALLBACK_TOOL_NAME = 'request_office_fallback'
export const DOCUMENT_UNSUPPORTED_MARKER = 'LEGALWORK_DOCUMENT_UNSUPPORTED'
const MAX_TICKET_BYTES = 32 * 1024
const MAX_TICKET_AGE_MS = 30 * 60 * 1000

export function createRequestOfficeFallbackTool(): LocalTool {
  return LocalToolHost.defineTool({
    name: REQUEST_OFFICE_FALLBACK_TOOL_NAME,
    description:
      'Unlock the Office MCP for this turn only after the legal-document-formatting local worker has explicitly returned unsupported and provided a fallback_ticket. This tool does not edit the document.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string' },
        reason: { type: 'string' }
      },
      required: ['ticket'],
      additionalProperties: false
    },
    policy: 'auto',
    toolKind: 'tool_call',
    shouldAdvertise: (context) => isLegalDocumentFormattingActive(context),
    execute: async (args, context) => {
      const ticket = typeof args.ticket === 'string' ? args.ticket.trim() : ''
      if (!ticket) {
        return {
          output: { error: 'fallback ticket is required' },
          isError: true
        }
      }
      const validation = await validateFallbackTicket(ticket)
      if (!validation.ok) {
        return {
          output: {
            error: validation.error,
            note: 'Run the legal-document-formatting local worker first. Office MCP cannot be unlocked without a worker-generated unsupported ticket.'
          },
          isError: true
        }
      }
      grantOfficeFallback(context)
      await unlink(validation.path).catch(() => undefined)
      return {
        output: {
          granted: true,
          scope: 'turn',
          reason: validation.reason,
          operation: validation.operation,
          note: 'Office MCP is now available only for this turn as a last-resort fallback. Use the minimum necessary calls.'
        }
      }
    }
  })
}

async function validateFallbackTicket(rawPath: string): Promise<
  | { ok: true; path: string; reason: string; operation: string }
  | { ok: false; error: string }
> {
  const path = resolve(rawPath)
  const root = resolve(tmpdir(), 'legalwork-office-fallback')
  const rel = relative(root, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: 'fallback ticket must be created by the LegalWork document worker' }
  }
  try {
    const fileStat = await stat(path)
    if (!fileStat.isFile()) return { ok: false, error: 'fallback ticket is not a file' }
    if (fileStat.size <= 0 || fileStat.size > MAX_TICKET_BYTES) {
      return { ok: false, error: 'fallback ticket has an invalid size' }
    }
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (
      parsed.marker !== DOCUMENT_UNSUPPORTED_MARKER ||
      parsed.status !== 'unsupported' ||
      parsed.source !== 'legal-document-formatting'
    ) {
      return { ok: false, error: 'fallback ticket is not a valid document-worker unsupported result' }
    }
    const createdAt = typeof parsed.created_at === 'string' ? Date.parse(parsed.created_at) : Number.NaN
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > MAX_TICKET_AGE_MS || createdAt - Date.now() > 60_000) {
      return { ok: false, error: 'fallback ticket is expired or has an invalid timestamp' }
    }
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
    const operation = typeof parsed.operation === 'string' ? parsed.operation.trim() : ''
    if (!reason || !operation) {
      return { ok: false, error: 'fallback ticket is missing operation/reason evidence' }
    }
    return { ok: true, path, reason, operation }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
