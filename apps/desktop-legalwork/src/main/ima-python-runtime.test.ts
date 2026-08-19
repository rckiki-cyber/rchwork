import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  firstSupportedStandalonePython,
  imaStandalonePythonCandidates
} from './ima-python-runtime'

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

  it('uses the first supported managed Python across user and runtime data roots', async () => {
    const candidates = ['C:\\user-data\\python.exe', 'C:\\runtime-data\\python.exe']
    const checked: string[] = []

    const selected = await firstSupportedStandalonePython(candidates, async (candidate) => {
      checked.push(candidate)
      return candidate.includes('runtime-data')
    })

    expect(selected).toBe('C:\\runtime-data\\python.exe')
    expect(checked).toEqual(candidates)
  })

  it('returns null when no managed Python is supported', async () => {
    await expect(firstSupportedStandalonePython(['python-a', 'python-b'], () => false))
      .resolves.toBeNull()
  })
})
