import { describe, expect, it } from 'vitest'
import {
  isNoProjectWorkspaceRoot,
  NO_PROJECT_WORKSPACE_ROOT
} from '@shared/workspace-context'
import {
  isInternalTemporaryWorkspace,
  isLegalworkDocumentWorkspace,
  isLegalworkResearchWorkspace,
  normalizeWorkspaceRoot,
  workspaceRootIdentityKey
} from './workspace-path'

describe('no-project workspace', () => {
  it('recognizes both the portable marker and expanded home paths', () => {
    expect(isNoProjectWorkspaceRoot(NO_PROJECT_WORKSPACE_ROOT)).toBe(true)
    expect(isNoProjectWorkspaceRoot('/Users/test/Desktop')).toBe(true)
    expect(isNoProjectWorkspaceRoot('C:\\Users\\test\\Desktop\\')).toBe(true)
    // Legacy pre-v0.3.17 path must still be recognized
    expect(isNoProjectWorkspaceRoot('/Users/test/.legalwork/no_project_workspace')).toBe(true)
  })

  it('does not treat files/dirs under Desktop as no-project', () => {
    expect(isNoProjectWorkspaceRoot('/Users/test/Desktop/foo')).toBe(false)
    expect(isNoProjectWorkspaceRoot('/Users/test/Desktop/legalwork')).toBe(false)
  })

  it('does not misclassify a real project named Desktop', () => {
    expect(isNoProjectWorkspaceRoot('/Users/test/projects/Desktop')).toBe(false)
    expect(isNoProjectWorkspaceRoot('/data/Desktop')).toBe(false)
  })

  it('canonicalizes expanded paths to one stable identity', () => {
    expect(normalizeWorkspaceRoot('/Users/test/Desktop')).toBe(
      NO_PROJECT_WORKSPACE_ROOT
    )
    expect(workspaceRootIdentityKey('/Users/test/Desktop')).toBe(
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

  it('keeps document-writing scratch workspace out of project and code-thread views', () => {
    expect(isLegalworkDocumentWorkspace('~/.legalwork/document-workspace')).toBe(true)
    expect(isLegalworkDocumentWorkspace('/Users/test/.legalwork/document-workspace')).toBe(true)
    expect(isLegalworkDocumentWorkspace('~/.legalwork/research-workspace')).toBe(false)
    expect(isLegalworkResearchWorkspace('~/.legalwork/document-workspace')).toBe(false)
    expect(isInternalTemporaryWorkspace('~/.legalwork/document-workspace')).toBe(true)
    expect(isInternalTemporaryWorkspace('/Users/test/.legalwork/document-workspace')).toBe(true)
    expect(normalizeWorkspaceRoot('/Users/test/.legalwork/document-workspace')).toBe('')
  })
})
