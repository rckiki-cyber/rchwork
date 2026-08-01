import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { imaStandalonePythonCandidates } from './ima-python-runtime'

describe('imaStandalonePythonCandidates', () => {
  it('reuses the managed portable Python on macOS and Linux', () => {
    expect(imaStandalonePythonCandidates('/user-data', '/legalwork-data', 'darwin')).toEqual([
      join('/user-data', 'data-compliance', 'python-standalone', 'bin', 'python3'),
      join('/legalwork-data', 'data-compliance', 'python-standalone', 'bin', 'python3')
    ])
  })

  it('uses the portable Windows executable', () => {
    expect(imaStandalonePythonCandidates('C:\\user-data', 'C:\\legalwork-data', 'win32'))
      .toEqual([
        join('C:\\user-data', 'data-compliance', 'python-standalone', 'python.exe'),
        join('C:\\legalwork-data', 'data-compliance', 'python-standalone', 'python.exe')
      ])
  })
})
