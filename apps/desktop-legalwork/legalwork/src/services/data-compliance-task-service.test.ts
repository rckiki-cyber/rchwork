import { describe, expect, it } from 'vitest'
import {
  isSupportedDataCompliancePythonVersion,
  parsePythonVersionOutput
} from './data-compliance-task-service.js'

describe('data compliance Python version helpers', () => {
  it('requires Python 3.10 or newer', () => {
    expect(parsePythonVersionOutput('Python 3.11.9')).toEqual({ major: 3, minor: 11, patch: 9 })
    expect(isSupportedDataCompliancePythonVersion('Python 3.9.18')).toBe(false)
    expect(isSupportedDataCompliancePythonVersion('Python 3.10.0')).toBe(true)
    expect(isSupportedDataCompliancePythonVersion('Python 3.12.1')).toBe(true)
  })
})
