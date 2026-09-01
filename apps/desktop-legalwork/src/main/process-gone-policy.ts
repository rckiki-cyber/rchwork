export type ProcessGoneDetails = {
  reason: string
  exitCode?: number
  type?: string
}

export function shouldReportRenderProcessGone(
  details: ProcessGoneDetails,
  isQuitting: boolean
): boolean {
  if (isQuitting) return false
  return details.reason !== 'clean-exit' && details.reason !== 'killed'
}

/** Electron normally restarts isolated GPU and Utility helper processes.
 * Report only a repeated crash burst for those helpers; a single crash is
 * usually Chromium self-recovery rather than an actionable app failure. */
export class ChildProcessGoneReportPolicy {
  private recoverableCrashTimes = new Map<string, number[]>()

  constructor(
    private readonly gpuCrashThreshold = 3,
    private readonly gpuCrashWindowMs = 60_000
  ) {}

  shouldReport(details: ProcessGoneDetails, isQuitting: boolean, now = Date.now()): boolean {
    if (isQuitting) return false
    if (details.reason === 'clean-exit' || details.reason === 'killed') return false
    if (!['GPU', 'Utility'].includes(details.type ?? '') || details.reason !== 'crashed') return true

    const type = details.type ?? 'unknown'
    const recent = (this.recoverableCrashTimes.get(type) ?? [])
      .filter((time) => now - time <= this.gpuCrashWindowMs)
    recent.push(now)
    if (recent.length < this.gpuCrashThreshold) {
      this.recoverableCrashTimes.set(type, recent)
      return false
    }
    this.recoverableCrashTimes.delete(type)
    return true
  }
}
