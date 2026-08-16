import { BrowserWindow } from 'electron'

/**
 * 元典 MCP 软件内控制台（仿 IMA/北大法宝 模式）。
 *
 * 独立持久化 partition + 干净 BrowserWindow（不继承主窗口 preload），
 * 保证第三方控制台在 Electron 内正常渲染，登录/密钥管理状态持久保留。
 */

// 独立持久化 session：登录状态与应用主会话隔离，重启应用后仍保留。
export const YUANDIAN_SESSION_PARTITION = 'persist:yuandian'

// 元典控制台。
export const YUANDIAN_CONSOLE_URL = 'https://open.chineselaw.com/profile'

// 与 IMA/北大法宝窗口一致的固定 UA。
const YUANDIAN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

let yuandianWindow: BrowserWindow | null = null

/** 打开（或聚焦已打开的）元典控制台内置窗口。 */
export function openYuandianConsoleWindow(url: string = YUANDIAN_CONSOLE_URL): BrowserWindow {
  if (yuandianWindow && !yuandianWindow.isDestroyed()) {
    yuandianWindow.show()
    yuandianWindow.focus()
    return yuandianWindow
  }

  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    title: '元典 MCP 控制台',
    autoHideMenuBar: true,
    webPreferences: {
      partition: YUANDIAN_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  yuandianWindow = win
  win.on('closed', () => {
    if (yuandianWindow === win) yuandianWindow = null
  })

  // 控制台内部打开的 target=_blank 一律留在本窗口内导航。
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith('https://open.chineselaw.com')) {
      void win.loadURL(targetUrl)
    }
    return { action: 'deny' }
  })

  void win.loadURL(url, { userAgent: YUANDIAN_UA })
  return win
}
