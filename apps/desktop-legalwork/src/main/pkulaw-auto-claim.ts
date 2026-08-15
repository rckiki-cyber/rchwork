import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logInfo, logWarn } from './logger'
import { claimPkulawDailyToken } from './pkulaw-auth-manager'

/**
 * 北大法宝"每日自动领取"状态与调度。
 *
 * 开关状态与"今日已领取"记录存在独立状态文件（避免侵入 AppSettings 整套 schema）。
 * 调度器不在应用启动第一秒触发：45 秒后开始，之后按需间隔轮询，仅当开关开启、
 * 今日未领取时才会真正发起领取（隐藏窗口静默执行，不影响 agent 连接）。
 */

interface PkulawAutoClaimState {
  enabled: boolean
  lastClaimDate: string | null
}

function statePath(): string {
  return join(app.getPath('userData'), 'pkulaw-auto-claim.json')
}

function readState(): PkulawAutoClaimState {
  try {
    if (!existsSync(statePath())) return { enabled: false, lastClaimDate: null }
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<PkulawAutoClaimState>
    return {
      enabled: raw.enabled === true,
      lastClaimDate: typeof raw.lastClaimDate === 'string' ? raw.lastClaimDate : null
    }
  } catch {
    return { enabled: false, lastClaimDate: null }
  }
}

function writeState(state: PkulawAutoClaimState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state, null, 2))
  } catch {
    /* ignore */
  }
}

export function getPkulawAutoClaimState(): { enabled: boolean; lastClaimDate: string | null } {
  return readState()
}

export function setPkulawAutoClaimEnabled(enabled: boolean): { enabled: boolean; lastClaimDate: string | null } {
  const state = readState()
  state.enabled = enabled
  if (!enabled) state.lastClaimDate = null
  writeState(state)
  return state
}

function localToday(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

let claimInFlight = false

/**
 * 后台尝试一次自动领取。返回下次调度前的间隔（毫秒）。
 */
async function tickPkulawAutoClaim(): Promise<number> {
  const state = readState()
  if (!state.enabled) return 60_000
  if (state.lastClaimDate === localToday()) return 3_600_000 // 今日已领，低频复查
  if (claimInFlight) return 30_000
  claimInFlight = true
  try {
    const result = await claimPkulawDailyToken({ silent: true })
    if (result.ok || result.alreadyClaimed) {
      const next = readState()
      next.lastClaimDate = localToday()
      writeState(next)
      logInfo('pkulaw-auto-claim', result.message)
      return 3_600_000
    }
    logWarn('pkulaw-auto-claim', result.message)
    // 未登录时降低轮询频率，避免反复空转；其余失败较快重试。
    return result.needLogin ? 600_000 : 60_000
  } catch (error) {
    logWarn('pkulaw-auto-claim', error instanceof Error ? error.message : String(error))
    return 60_000
  } finally {
    claimInFlight = false
  }
}

let schedulerStarted = false

/** 启动每日自动领取调度：45 秒后才开始第一次检查，之后按需间隔轮询。 */
export function startPkulawAutoClaimScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true
  setTimeout(run, 45_000)
  function run(): void {
    void tickPkulawAutoClaim().then((delay) => setTimeout(run, delay))
  }
}
