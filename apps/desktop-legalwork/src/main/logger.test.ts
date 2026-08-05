import { describe, expect, it, vi } from 'vitest'
import { setLogErrorReporter, logError } from './logger'

describe('logError report enrichment', () => {
  it('appends a Node error code from detail.message to the report message', () => {
    const report = vi.fn()
    setLogErrorReporter(report)
    try {
      logError('claw-webhook', 'Claw IM webhook server failed', {
        message: 'listen EADDRINUSE: address already in use 127.0.0.1:8788'
      })
    } finally {
      setLogErrorReporter(null)
    }

    expect(report).toHaveBeenCalledTimes(1)
    const [payload] = report.mock.calls[0] as [{ message: string }]
    expect(payload.message).toContain('Claw IM webhook server failed')
    expect(payload.message).toContain('EADDRINUSE')
  })

  it('does not append when detail.message matches the top-level message', () => {
    const report = vi.fn()
    setLogErrorReporter(report)
    try {
      logError('schedule-server', 'Schedule internal server failed', {
        message: 'Schedule internal server failed'
      })
    } finally {
      setLogErrorReporter(null)
    }

    const [payload] = report.mock.calls[0] as [{ message: string }]
    expect(payload.message).toBe('Schedule internal server failed')
  })

  it('does not append when the cause is already contained in the message', () => {
    const report = vi.fn()
    setLogErrorReporter(report)
    try {
      logError('schedule-server', 'Schedule internal server failed', {
        message: 'Schedule internal server failed with retry limit reached'
      })
    } finally {
      setLogErrorReporter(null)
    }

    const [payload] = report.mock.calls[0] as [{ message: string }]
    expect(payload.message).toBe('Schedule internal server failed')
  })

  it('strips absolute paths from a free-form detail message (privacy)', () => {
    const report = vi.fn()
    setLogErrorReporter(report)
    try {
      logError('read', 'document text extraction returned no readable text', {
        message: "ENOENT: no such file or directory, open '/Users/alice/Desktop/秘密合同.docx'"
      })
    } finally {
      setLogErrorReporter(null)
    }

    const [payload] = report.mock.calls[0] as [{ message: string }]
    // The error code ENOENT is safe to include; the path must not leak.
    expect(payload.message).toContain('ENOENT')
    expect(payload.message).not.toContain('/Users/alice')
    expect(payload.message).not.toContain('秘密合同.docx')
  })

  it('does not include free-form detail fields (privacy)', () => {
    const report = vi.fn()
    setLogErrorReporter(report)
    try {
      logError('schedule-task', 'Scheduled task failed', {
        message: 'task aborted',
        text: '用户私密文书内容：' + 'A'.repeat(5000),
        taskId: 'task-123',
        threadId: 'thr_secret'
      })
    } finally {
      setLogErrorReporter(null)
    }

    const [payload] = report.mock.calls[0] as [{ message: string; stack?: string }]
    expect(payload.message).toContain('task aborted')
    expect(payload.message).not.toContain('用户私密文书内容')
    expect(payload.message).not.toContain('task-123')
    expect(payload.message).not.toContain('thr_secret')
  })

  it('does not append a long free-form cause that contains PII', () => {
    const report = vi.fn()
    setLogErrorReporter(report)
    try {
      logError('write', 'write failed', {
        message: "EPERM: operation not permitted, mkdir 'D:\\'"
      })
    } finally {
      setLogErrorReporter(null)
    }

    const [payload] = report.mock.calls[0] as [{ message: string }]
    // EPERM code is allowed; the Windows drive path after it is stripped.
    expect(payload.message).toContain('EPERM')
    expect(payload.message).not.toContain("D:\\")
  })

  it('still reports the plain message when detail has no message field', () => {
    const report = vi.fn()
    setLogErrorReporter(report)
    try {
      logError('claw-webhook', 'Claw IM webhook server failed', { someDetail: 1 })
    } finally {
      setLogErrorReporter(null)
    }

    const [payload] = report.mock.calls[0] as [{ message: string }]
    expect(payload.message).toBe('Claw IM webhook server failed')
  })
})
