import { describe, expect, it } from 'vitest'
import {
  ChildProcessGoneReportPolicy,
  shouldReportRenderProcessGone
} from './process-gone-policy'

describe('process-gone reporting policy', () => {
  it('does not report intentional renderer termination or app shutdown', () => {
    expect(shouldReportRenderProcessGone({ reason: 'killed', exitCode: -1073741510 }, false)).toBe(false)
    expect(shouldReportRenderProcessGone({ reason: 'crashed', exitCode: 1 }, true)).toBe(false)
    expect(shouldReportRenderProcessGone({ reason: 'crashed', exitCode: 1 }, false)).toBe(true)
  })

  it('reports GPU crashes only after a repeated burst', () => {
    const policy = new ChildProcessGoneReportPolicy(3, 60_000)
    const details = { type: 'GPU', reason: 'crashed', exitCode: 34 }

    expect(policy.shouldReport(details, false, 1_000)).toBe(false)
    expect(policy.shouldReport(details, false, 2_000)).toBe(false)
    expect(policy.shouldReport(details, false, 3_000)).toBe(true)
  })

  it('debounces isolated Utility crashes because Chromium restarts those helper processes too', () => {
    const policy = new ChildProcessGoneReportPolicy(3, 60_000)
    const details = { type: 'Utility', reason: 'crashed', exitCode: -1073741205 }

    expect(policy.shouldReport(details, false, 1_000)).toBe(false)
    expect(policy.shouldReport(details, false, 2_000)).toBe(false)
    expect(policy.shouldReport(details, false, 3_000)).toBe(true)
  })

  it('still reports other child crashes immediately', () => {
    const policy = new ChildProcessGoneReportPolicy()
    expect(policy.shouldReport({ type: 'Audio Service', reason: 'crashed', exitCode: 1 }, false)).toBe(true)
  })
})
