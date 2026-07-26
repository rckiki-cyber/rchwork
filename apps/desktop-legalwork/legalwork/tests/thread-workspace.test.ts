import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createThreadRecord, expandThreadWorkspace } from '../src/domain/thread.js'

describe('thread workspace expansion', () => {
  it('expands the home directory marker', () => {
    expect(expandThreadWorkspace('~')).toBe(homedir())
    expect(expandThreadWorkspace('~/.legalwork/no_project_workspace')).toBe(
      join(homedir(), '.legalwork', 'no_project_workspace')
    )
  })

  it('persists an absolute workspace on new threads', () => {
    const thread = createThreadRecord({
      id: 'thr_no_project',
      title: 'No project',
      workspace: '~/.legalwork/no_project_workspace',
      model: 'deepseek-chat'
    })

    expect(thread.workspace).toBe(join(homedir(), '.legalwork', 'no_project_workspace'))
  })
})
