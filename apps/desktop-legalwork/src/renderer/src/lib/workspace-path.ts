import {
  isNoProjectWorkspaceRoot,
  NO_PROJECT_WORKSPACE_ROOT
} from '@shared/workspace-context'

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function workspaceRootIdentityKey(path?: string): string {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return ''
  if (isNoProjectWorkspaceRoot(trimmed)) return NO_PROJECT_WORKSPACE_ROOT
  const normalized = normalizePathForMatch(trimmed)
  if (
    normalized === '~/.deepseekgui/default_workspace'
    || normalized.endsWith('/.deepseekgui/default_workspace')
  ) {
    return '~/.deepseekgui/default_workspace'
  }
  return normalized
}

/** Dedicated workspace for legal-research threads. Kept out of the main
 * "code" thread list (isCodeThread) so research turns never surface in the
 * home agent conversation. */
export function isLegalworkResearchWorkspace(path?: string): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return false
  const normalized = normalizePathForMatch(trimmed)
  return normalized.includes('/.legalwork/research-workspace')
}

export function isInternalTemporaryWorkspace(path?: string): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return false
  const normalized = normalizePathForMatch(trimmed)
  return (
    /\/deepseek-tui-updates\/tmp(?:\/|$)/.test(normalized)
    || normalized === '/tmp'
    || normalized.startsWith('/tmp/')
    || normalized === '/private/tmp'
    || normalized.startsWith('/private/tmp/')
    || /^\/var\/folders\/[^/]+\/[^/]+\/t(?:\/|$)/.test(normalized)
    || /^\/private\/var\/folders\/[^/]+\/[^/]+\/t(?:\/|$)/.test(normalized)
    || /\/appdata\/local\/temp(?:\/|$)/.test(normalized)
    || isLegalworkResearchWorkspace(path)
  )
}

export function isClawWorkspacePath(path?: string): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return false
  const normalized = normalizePathForMatch(trimmed)
  return normalized.includes('/.legalwork/claw/') || normalized.includes('/.deepseekgui/claw/')
}

export function isInternalDeepSeekGuiWorkspace(path?: string): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return false
  const normalized = normalizePathForMatch(trimmed)
  return (
    normalized === '~/.legalwork/write_workspace'
    || normalized === '~/.legalwork/default_workspace'
    || normalized === '~/.deepseekgui/write_workspace'
    || normalized.endsWith('/.legalwork/write_workspace')
    || normalized.endsWith('/.legalwork/default_workspace')
    || normalized.endsWith('/.deepseekgui/write_workspace')
  )
}

export function normalizeWorkspaceRoot(path?: string): string {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return ''
  if (isNoProjectWorkspaceRoot(trimmed)) return NO_PROJECT_WORKSPACE_ROOT
  if (isInternalTemporaryWorkspace(trimmed)) return ''
  return trimmed
}
