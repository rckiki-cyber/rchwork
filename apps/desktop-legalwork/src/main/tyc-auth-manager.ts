import { BrowserWindow } from 'electron'

/**
 * 天眼查 MCP 软件内控制台（仿 元典/北大法宝 模式）。
 *
 * 独立持久化 partition + 干净 BrowserWindow（不继承主窗口 preload），
 * 保证第三方控制台在 Electron 内正常渲染，登录/密钥管理状态持久保留。
 */

// 独立持久化 session：登录状态与应用主会话隔离，重启应用后仍保留。
export const TYC_SESSION_PARTITION = 'persist:tyc'

// 天眼查 AI / MCP 门户（含 API Key 与登录入口）。
export const TYC_CONSOLE_URL = 'https://www.tianyancha.com/ai'

// 与 IMA/北大法宝/元典窗口一致的固定 UA。
const TYC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

let tycWindow: BrowserWindow | null = null

/** 打开（或聚焦已打开的）天眼查控制台内置窗口，供用户登录/获取 API Key。 */
export function openTycConsoleWindow(url: string = TYC_CONSOLE_URL): BrowserWindow {
  if (tycWindow && !tycWindow.isDestroyed()) {
    tycWindow.show()
    tycWindow.focus()
    return tycWindow
  }

  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    title: '天眼查控制台',
    autoHideMenuBar: true,
    webPreferences: {
      partition: TYC_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  tycWindow = win
  win.on('closed', () => {
    if (tycWindow === win) tycWindow = null
  })

  // 控制台内部打开的 target=_blank 一律留在本窗口内导航。
  // 按 hostname 匹配 tianyancha.com 及其子域（www / mcp / 登录回调等）。
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    try {
      const host = new URL(targetUrl).hostname
      if (host === 'tianyancha.com' || host.endsWith('.tianyancha.com')) {
        void win.loadURL(targetUrl)
      }
    } catch {
      /* ignore malformed url */
    }
    return { action: 'deny' }
  })

  void win.loadURL(url, { userAgent: TYC_UA })
  return win
}
