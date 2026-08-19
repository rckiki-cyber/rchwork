import { BrowserWindow } from 'electron'

/**
 * 企查查 MCP 软件内控制台（仿 元典/北大法宝 模式）。
 *
 * 独立持久化 partition + 干净 BrowserWindow（不继承主窗口 preload），
 * 保证第三方控制台在 Electron 内正常渲染，登录/密钥管理状态持久保留。
 */

// 独立持久化 session：登录状态与应用主会话隔离，重启应用后仍保留。
export const QCC_SESSION_PARTITION = 'persist:qcc'

// 企查查 MCP 配置台（API Key 管理）。
export const QCC_CONSOLE_URL = 'https://agent.qcc.com/profile/api-key'

// 与 IMA/北大法宝/元典窗口一致的固定 UA。
const QCC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

let qccWindow: BrowserWindow | null = null

/** 打开（或聚焦已打开的）企查查控制台内置窗口，供用户登录/获取 API Key。 */
export function openQccConsoleWindow(url: string = QCC_CONSOLE_URL): BrowserWindow {
  if (qccWindow && !qccWindow.isDestroyed()) {
    qccWindow.show()
    qccWindow.focus()
    return qccWindow
  }

  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    title: '企查查控制台',
    autoHideMenuBar: true,
    webPreferences: {
      partition: QCC_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  qccWindow = win
  win.on('closed', () => {
    if (qccWindow === win) qccWindow = null
  })

  // 控制台内部打开的 target=_blank 一律留在本窗口内导航。
  // 按 hostname 匹配 qcc.com 及其子域（agent / 登录回调等）。
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    try {
      const host = new URL(targetUrl).hostname
      if (host === 'qcc.com' || host.endsWith('.qcc.com')) {
        void win.loadURL(targetUrl)
      }
    } catch {
      /* ignore malformed url */
    }
    return { action: 'deny' }
  })

  void win.loadURL(url, { userAgent: QCC_UA })
  return win
}
