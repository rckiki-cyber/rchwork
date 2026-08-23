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

/** Electron normally restarts an isolated GPU process crash. Report only a
 * repeated crash burst, which is actionable evidence of a persistent fault. */
export class ChildProcessGoneReportPolicy {
  private gpuCrashTimes: number[] = []

  constructor(
    private readonly gpuCrashThreshold = 3,
    private readonly gpuCrashWindowMs = 60_000
  ) {}

  shouldReport(details: ProcessGoneDetails, isQuitting: boolean, now = Date.now()): boolean {
    if (isQuitting) return false
    if (details.reason === 'clean-exit' || details.reason === 'killed') return false
    if (details.type !== 'GPU' || details.reason !== 'crashed') return true

    this.gpuCrashTimes = this.gpuCrashTimes.filter((time) => now - time <= this.gpuCrashWindowMs)
    this.gpuCrashTimes.push(now)
    if (this.gpuCrashTimes.length < this.gpuCrashThreshold) return false
    this.gpuCrashTimes = []
    return true
  }
}
