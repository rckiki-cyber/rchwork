export const NO_PROJECT_WORKSPACE_ROOT = '~/Desktop'

/** Legacy no-project root used before v0.3.17. Existing threads still point
 * here; keep recognizing it so history and file previews keep working. */
const LEGACY_NO_PROJECT_WORKSPACE_SUFFIX = '/.legalwork/no_project_workspace'

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isDesktopRoot(normalized: string): boolean {
  // Match the portable marker and the expanded user-desktop root itself, but
  // NOT arbitrary directories that merely end in "desktop". Restrict to the
  // conventional home locations (macOS/Windows: .../Users/<name>/Desktop,
  // Linux: .../home/<name>/Desktop) so a real project named "Desktop" is not
  // misclassified as the no-project root.
  const withoutTrailing = normalized.replace(/\/+$/, '')
  return (
    withoutTrailing === '~/desktop'
    || /(^|\/)users\/[^/]+\/desktop$/i.test(withoutTrailing)
    || /(^|\/)home\/[^/]+\/desktop$/i.test(withoutTrailing)
  )
}

export function isNoProjectWorkspaceRoot(path?: string | null): boolean {
  const value = path?.trim() ?? ''
  if (!value) return false
  const normalized = normalizePathForMatch(value)
  return (
    normalized === NO_PROJECT_WORKSPACE_ROOT.toLowerCase()
    || isDesktopRoot(normalized)
    || normalized.endsWith(LEGACY_NO_PROJECT_WORKSPACE_SUFFIX)
  )
}
