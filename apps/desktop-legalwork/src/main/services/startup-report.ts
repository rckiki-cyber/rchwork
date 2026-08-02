import { getOrCreateDeviceId } from '../device-id'

/**
 * Startup reporting for unique-device statistics.
 *
 * The client reports a lightweight startup event (device id + app version +
 * platform) so installations can be counted per unique computer rather than
 * per download. The report endpoint is best-effort: failures are swallowed.
 */

export type StartupReportPayload = {
  deviceId: string
  version: string
  platform: NodeJS.Platform
  arch: string
  appId: string
  ts: number
}

/**
 * Report a startup event. `endpoint` is optional; when unset (or when the
 * network call fails) the event is only written to the local log so it can
 * still be audited.
 */
export async function reportStartup(input: {
  dataDir: string
  version: string
  platform: NodeJS.Platform
  arch: string
  appId: string
  endpoint?: string
}): Promise<void> {
  const deviceId = getOrCreateDeviceId(input.dataDir)
  const payload: StartupReportPayload = {
    deviceId,
    version: input.version,
    platform: input.platform,
    arch: input.arch,
    appId: input.appId,
    ts: Date.now()
  }

  const endpoint = input.endpoint?.trim()
  if (!endpoint) {
    console.log('[startup-report] no endpoint configured; device registered locally', payload.deviceId)
    return
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) {
      console.warn(`[startup-report] report failed status ${response.status}`)
    }
  } catch (error) {
    console.warn('[startup-report] report failed', error instanceof Error ? error.message : String(error))
  }
}
