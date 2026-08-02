import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Persistent, per-install random device id used to attribute startup reports
 * and error reports to a unique computer. Shared by startup-report and
 * error-report so both attribute to the same installation.
 */

const DEVICE_ID_FILENAME = 'device-id.json'

type DeviceIdFile = {
  deviceId: string
  createdAt: number
}

function readDeviceIdFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf8')) as DeviceIdFile
    return typeof raw.deviceId === 'string' && raw.deviceId.length > 0 ? raw.deviceId : null
  } catch {
    return null
  }
}

function writeDeviceIdFile(path: string, deviceId: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const payload: DeviceIdFile = { deviceId, createdAt: Date.now() }
    writeFileSync(path, JSON.stringify(payload), 'utf8')
  } catch {
    // Best-effort; a missing device id just means no report this run.
  }
}

export function getOrCreateDeviceId(dataDir: string): string {
  const path = join(dataDir, DEVICE_ID_FILENAME)
  const existing = readDeviceIdFile(path)
  if (existing) return existing
  const next = randomUUID()
  writeDeviceIdFile(path, next)
  return next
}
