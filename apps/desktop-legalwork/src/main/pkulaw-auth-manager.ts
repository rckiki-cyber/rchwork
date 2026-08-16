import { BrowserWindow } from 'electron'

/**
 * 北大法宝 MCP 软件内控制台（仿 IMA 登录窗口模式）。
 *
 * 关键点：新建的 BrowserWindow 不继承主窗口的 preload / webPreferences，
 * 只挂一个独立持久化 partition —— 这是 IMA 登录窗口能正常渲染第三方站点、
 * 而 target=_blank 继承窗口会导致 mcp.pkulaw.com 前端崩溃的原因。
 */

// 独立持久化 session：登录状态与应用主会话隔离，重启应用后仍保留。
export const PKULAW_SESSION_PARTITION = 'persist:pkulaw'

// 每日领取积分的控制台页面。
export const PKULAW_CONSOLE_URL = 'https://mcp.pkulaw.com/console/points'

// 与 IMA 登录窗口一致的固定 UA，保证控制台在 Electron 内按桌面浏览器语义渲染。
const PKULAW_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

let pkulawWindow: BrowserWindow | null = null

function createPkulawWindow(show: boolean, url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    show,
    title: '北大法宝 MCP 控制台',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PKULAW_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  win.on('closed', () => {
    if (pkulawWindow === win) pkulawWindow = null
  })

  // 控制台内部打开的 target=_blank 一律留在本窗口内导航。
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith('https://mcp.pkulaw.com')) {
      void win.loadURL(targetUrl)
    }
    return { action: 'deny' }
  })

  void win.loadURL(url, { userAgent: PKULAW_UA })
  return win
}

/** 打开（或聚焦已打开的）北大法宝控制台内置窗口，供用户登录/管理。 */
export function openPkulawConsoleWindow(url: string = PKULAW_CONSOLE_URL): BrowserWindow {
  if (pkulawWindow && !pkulawWindow.isDestroyed()) {
    pkulawWindow.show()
    pkulawWindow.focus()
    return pkulawWindow
  }
  const win = createPkulawWindow(true, url)
  pkulawWindow = win
  return win
}

export interface PkulawClaimResult {
  ok: boolean
  message: string
  /** 今日已领取过（无需再领） */
  alreadyClaimed?: boolean
  /** 控制台未登录，需要先登录后再领取 */
  needLogin?: boolean
  /** 领取前/后页面显示的可用积分（供核对真实到账） */
  pointsBefore?: string
  pointsAfter?: string
}

/**
 * 一键自动领取每日赠送积分。
 *
 * 全程在隐藏窗口内自动完成：加载积分页 → 校验登录态 → 自动点击"领取" → 校验到账 → 关窗。
 * silent 模式（每日自动领取）不弹窗、结束即关；手动按钮模式在未登录/找不到按钮时才弹出窗口。
 */
export async function claimPkulawDailyToken(options?: { silent?: boolean }): Promise<PkulawClaimResult> {
  const silent = options?.silent === true
  const win = createPkulawWindow(false, PKULAW_CONSOLE_URL)
  try {
    await waitForLoad(win)
    await sleep(2500) // 等待前端 hydration / 登录态重定向完成

    const probe = await runJs(win, `
      (() => {
        const body = document.body ? document.body.innerText : '';
        const points = (body.match(/当前可用积分[\\s\\S]{0,80}?([\\d.,]{4,})/) || [])[1] || '';
        return {
          loggedIn: /我的积分|使用账单|每日赠送/.test(body),
          claimed: /今日已领取/.test(body),
          points
        };
      })()
    `)

    if (!probe.loggedIn) {
      if (silent) closeWindow(win)
      else { win.show(); win.focus() }
      return {
        ok: false,
        needLogin: true,
        message: silent ? '控制台未登录，暂不领取' : '控制台未登录，已打开窗口，请先登录后再点领取'
      }
    }
    if (probe.claimed) {
      closeWindow(win)
      return { ok: false, alreadyClaimed: true, message: '今日已领取过积分' }
    }

    const click = await runJs(win, `
      (() => {
        const visible = (el) => el.offsetParent !== null;
        const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
          .filter((el) => visible(el))
          .map((el) => ({ el, t: (el.innerText || '').trim().replace(/\\s+/g, ' ') }))
          .filter(({ t }) => t.length > 0 && t.length <= 12 && /领取/.test(t) && !/已领取|充值|购买|兑换|查看|去领/.test(t))
          .sort((a, b) => a.t.length - b.t.length);
        if (candidates.length === 0) {
          const diag = Array.from(document.querySelectorAll('button, a, span, div'))
            .filter((el) => visible(el))
            .map((el) => (el.innerText || '').trim().replace(/\\s+/g, ' '))
            .filter((t) => t.length > 0 && t.length <= 20 && /领取/.test(t))
            .slice(0, 8);
          return { clicked: false, diagnostic: JSON.stringify(diag) };
        }
        candidates[0].el.click();
        return { clicked: true };
      })()
    `)

    if (!click.clicked) {
      if (silent) closeWindow(win)
      else { win.show(); win.focus() }
      return {
        ok: false,
        message: `未找到"领取"按钮（页面含：${click.diagnostic}）${silent ? '' : '，已打开窗口可手动领取'}`
      }
    }

    await sleep(2500)
    const after = await runJs(win, `
      (() => {
        const body = document.body ? document.body.innerText : '';
        const points = (body.match(/当前可用积分[\\s\\S]{0,80}?([\\d.,]{4,})/) || [])[1] || '';
        return { claimed: /今日已领取/.test(body), points };
      })()
    `)
    closeWindow(win)

    if (after.claimed) {
      const pointsChanged = Boolean(probe.points && after.points && probe.points !== after.points)
      return {
        ok: true,
        message: pointsChanged
          ? `领取成功，积分已到账（${probe.points} → ${after.points}）`
          : '领取成功，页面已显示"今日已领取"',
        pointsBefore: probe.points,
        pointsAfter: after.points
      }
    }
    return {
      ok: false,
      message: '已点击"领取"，但页面未显示领取成功，可能是站点响应问题',
      pointsBefore: probe.points,
      pointsAfter: after.points
    }
  } catch (error) {
    closeWindow(win)
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function closeWindow(win: BrowserWindow): void {
  if (!win.isDestroyed()) {
    win.destroy()
  }
}

function waitForLoad(win: BrowserWindow, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    if (win.isDestroyed() || !win.webContents.isLoading()) return resolve()
    const timer = setInterval(() => {
      if (win.isDestroyed()) {
        clearInterval(timer)
        resolve()
        return
      }
      if (!win.webContents.isLoading()) {
        clearInterval(timer)
        resolve()
      }
    }, 300)
    // 超时兜底：页面加载挂起（网络黑洞）时不再无限等待，避免隐藏窗口泄漏、claimInFlight 永久卡死
    setTimeout(() => { clearInterval(timer); resolve() }, timeoutMs)
  })
}

/** 包裹 executeJavaScript，主帧繁忙时不再无限等待；超时抛错由上层 catch 关闭窗口并复位。 */
async function runJs(win: BrowserWindow, code: string, label = '页面脚本'): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(code),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时(30s)，已中止领取流程`)), 30_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
