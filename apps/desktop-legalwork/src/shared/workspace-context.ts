export const NO_PROJECT_WORKSPACE_ROOT = '~/.legalwork/no_project_workspace'

const NO_PROJECT_WORKSPACE_SUFFIX = '/.legalwork/no_project_workspace'

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function isNoProjectWorkspaceRoot(path?: string | null): boolean {
  const value = path?.trim() ?? ''
  if (!value) return false
  const normalized = normalizePathForMatch(value)
  return (
    normalized === NO_PROJECT_WORKSPACE_ROOT.toLowerCase()
    || normalized.endsWith(NO_PROJECT_WORKSPACE_SUFFIX)
  )
}
