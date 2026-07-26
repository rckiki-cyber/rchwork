import { describe, expect, it } from 'vitest'
import {
  isNoProjectWorkspaceRoot,
  NO_PROJECT_WORKSPACE_ROOT
} from '@shared/workspace-context'
import { normalizeWorkspaceRoot, workspaceRootIdentityKey } from './workspace-path'

describe('no-project workspace', () => {
  it('recognizes both the portable marker and expanded home paths', () => {
    expect(isNoProjectWorkspaceRoot(NO_PROJECT_WORKSPACE_ROOT)).toBe(true)
    expect(isNoProjectWorkspaceRoot('/Users/test/.legalwork/no_project_workspace')).toBe(true)
    expect(isNoProjectWorkspaceRoot('C:\\Users\\test\\.legalwork\\no_project_workspace\\')).toBe(true)
  })

  it('canonicalizes expanded paths to one stable identity', () => {
    expect(normalizeWorkspaceRoot('/Users/test/.legalwork/no_project_workspace')).toBe(
      NO_PROJECT_WORKSPACE_ROOT
    )
    expect(workspaceRootIdentityKey('/Users/test/.legalwork/no_project_workspace')).toBe(
      NO_PROJECT_WORKSPACE_ROOT
    )
    expect(workspaceRootIdentityKey(NO_PROJECT_WORKSPACE_ROOT)).toBe(
      NO_PROJECT_WORKSPACE_ROOT
    )
  })

  it('does not change ordinary project paths', () => {
    expect(normalizeWorkspaceRoot('/Users/test/legalwork')).toBe('/Users/test/legalwork')
    expect(isNoProjectWorkspaceRoot('/Users/test/legalwork')).toBe(false)
  })
})
