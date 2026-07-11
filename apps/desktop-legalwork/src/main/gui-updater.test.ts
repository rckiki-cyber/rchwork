import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockUpdater = EventEmitter & {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  forceDevUpdateConfig: boolean
  logger: unknown
  setFeedURL: ReturnType<typeof vi.fn>
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
}

let updater: MockUpdater
let nativeUpdater: EventEmitter
let mockApp: EventEmitter
const ORIGINAL_ENV = { ...process.env }

function createUpdater(): MockUpdater {
  return Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    forceDevUpdateConfig: false,
    logger: null,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.LEGALWORK_UPDATE_URL
  delete process.env.LEGALWORK_UPDATE_URL_STABLE
  delete process.env.LEGALWORK_UPDATE_URL_FRONTIER
  delete process.env.LEGALWORK_GITHUB_REPO
  delete process.env.LEGALWORK_UPDATE_CHANNEL
  updater = createUpdater()
  nativeUpdater = new EventEmitter()
  mockApp = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getAppPath: () => '/tmp/legalwork-updater-test-app',
    getPath: () => '/tmp/legalwork-updater-test-user-data',
    getVersion: () => '0.1.0'
  })
  vi.doMock('electron', () => ({
    app: mockApp,
    autoUpdater: nativeUpdater,
    BrowserWindow: class {}
  }))
  vi.doMock('electron-updater', () => ({
    default: { autoUpdater: updater },
    autoUpdater: updater
  }))
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  process.env = { ...ORIGINAL_ENV }
  vi.doUnmock('electron')
  vi.doUnmock('electron-updater')
  vi.resetModules()
})

describe('initializeGuiUpdater', () => {
  it('uses GitHub Releases as the packaged update feed when a repository is configured', async () => {
    process.env.LEGALWORK_GITHUB_REPO = 'sunyifeisb-art/legalwork'

    const module = await import('./gui-updater')
    module.initializeGuiUpdater(() => null, () => 'stable')

    expect(updater.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'github',
      owner: 'sunyifeisb-art',
      repo: 'legalwork'
    })
  })
})

describe('downloadGuiUpdate', () => {
  it('adds user-facing release highlights and filters technical changelog lines', async () => {
    process.env.LEGALWORK_GITHUB_REPO = 'sunyifeisb-art/legalwork'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: 'v0.2.0',
        name: 'LegalWork 0.2.0',
        published_at: '2026-06-06T00:00:00.000Z',
        body: [
          '## 更新内容',
          '- 新增文书写作模板库，起草常用法律文书更方便。',
          '- Bump TypeScript to 5.8',
          '- 修复自动更新安装失败的问题。',
          '- latest-mac.yml metadata refresh'
        ].join('\n')
      })
    })))
    updater.checkForUpdates.mockRejectedValueOnce(new Error('latest-mac.yml is missing'))

    const module = await import('./gui-updater')
    module.initializeGuiUpdater(() => null, () => 'stable')

    const info = await module.checkGuiUpdate('stable')

    expect(info).toMatchObject({
      ok: true,
      latestVersion: '0.2.0',
      releaseHighlights: [
        '新增文书写作模板库，起草常用法律文书更方便。',
        '修复自动更新安装失败的问题。'
      ]
    })
    expect(JSON.stringify(info)).not.toContain('TypeScript')
    expect(JSON.stringify(info)).not.toContain('latest-mac.yml')
  })

  it('strips HTML tags from release highlights before rendering them in settings', async () => {
    process.env.LEGALWORK_GITHUB_REPO = 'sunyifeisb-art/legalwork'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: 'v0.2.7',
        name: 'LegalWork 0.2.7',
        published_at: '2026-07-11T00:00:00.000Z',
        body: [
          '<h2>v0.2.7</h2>',
          '<ul>',
          '<li><strong>自动更新兜底安装</strong>： macOS 在原生 updater 未触发应用退出时，自动通过已下载的 zip 执行 shell 兜底安装，降低更新失败概率。</li>',
          '<li><strong>数据合规批量任务</strong>： 支持一次提交多个文件进行合规审查/脱敏，自动生成 <code>input_manifest.json</code> 并统一调度。</li>',
          '</ul>'
        ].join('\n')
      })
    })))
    updater.checkForUpdates.mockRejectedValueOnce(new Error('latest-mac.yml is missing'))

    const module = await import('./gui-updater')
    module.initializeGuiUpdater(() => null, () => 'stable')

    const info = await module.checkGuiUpdate('stable')

    expect(info).toMatchObject({
      ok: true,
      latestVersion: '0.2.7',
      releaseHighlights: [
        '自动更新兜底安装： macOS 在原生 updater 未触发应用退出时，自动通过已下载的 zip 执行 shell 兜底安装，降低更新失败概率。',
        '数据合规批量任务： 支持一次提交多个文件进行合规审查/脱敏，自动生成 input_manifest.json 并统一调度。'
      ]
    })
    expect(JSON.stringify(info)).not.toContain('<li>')
    expect(JSON.stringify(info)).not.toContain('<strong>')
    expect(JSON.stringify(info)).not.toContain('<code>')
  })

  it('retries the packaged updater when the previous check only found a manual GitHub fallback', async () => {
    process.env.LEGALWORK_GITHUB_REPO = 'sunyifeisb-art/legalwork'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: 'v0.2.0',
        published_at: '2026-06-06T00:00:00.000Z'
      })
    })))

    updater.checkForUpdates
      .mockRejectedValueOnce(new Error('latest-mac.yml is missing'))
      .mockResolvedValueOnce({
        updateInfo: { version: '0.2.0', releaseDate: '2026-06-06T00:00:00.000Z' },
        isUpdateAvailable: true
      })
    updater.downloadUpdate.mockResolvedValue(['/tmp/legalwork-0.2.0-mac-arm64.zip'])

    const module = await import('./gui-updater')
    module.initializeGuiUpdater(() => null, () => 'stable')

    const fallbackInfo = await module.checkGuiUpdate('stable')
    expect(fallbackInfo).toMatchObject({
      ok: true,
      hasUpdate: true,
      latestVersion: '0.2.0',
      manualOnly: true
    })

    await expect(module.downloadGuiUpdate('stable')).resolves.toEqual({
      ok: true,
      paths: ['/tmp/legalwork-0.2.0-mac-arm64.zip']
    })
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('installGuiUpdate', () => {
  it('waits for managed runtime cleanup before asking the updater to quit and install', async () => {
    const module = await import('./gui-updater')
    let finishCleanup = (): void => {
      throw new Error('cleanup resolver was not set')
    }
    const beforeInstall = vi.fn(() => new Promise<void>((resolve) => {
      finishCleanup = resolve
    }))
    const beforeQuitAndInstall = vi.fn()

    module.initializeGuiUpdater(() => null, () => 'stable', beforeInstall, beforeQuitAndInstall)
    updater.emit('update-downloaded', { version: '0.2.0', releaseDate: '2026-06-06T00:00:00.000Z' })

    const installing = module.installGuiUpdate()
    await Promise.resolve()

    expect(beforeInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    finishCleanup()
    await expect(installing).resolves.toEqual({ ok: true })
    expect(beforeQuitAndInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(beforeQuitAndInstall.mock.invocationCallOrder[0]).toBeLessThan(
      updater.quitAndInstall.mock.invocationCallOrder[0]
    )
  })

  it('reuses the same cleanup when the native updater emits before-quit-for-update', async () => {
    const module = await import('./gui-updater')
    let finishCleanup = (): void => {
      throw new Error('cleanup resolver was not set')
    }
    const beforeInstall = vi.fn(() => new Promise<void>((resolve) => {
      finishCleanup = resolve
    }))

    module.initializeGuiUpdater(() => null, () => 'stable', beforeInstall)
    updater.emit('update-downloaded', { version: '0.2.0', releaseDate: '2026-06-06T00:00:00.000Z' })

    nativeUpdater.emit('before-quit-for-update')
    const installing = module.installGuiUpdate()
    await Promise.resolve()

    expect(beforeInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    finishCleanup()
    await expect(installing).resolves.toEqual({ ok: true })
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('reports an install failure when quitAndInstall does not make the app quit', async () => {
    const module = await import('./gui-updater')
    const sentStates: unknown[] = []
    const afterQuitAndInstallAbort = vi.fn()
    const win = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: vi.fn((channel: string, state: unknown) => {
          if (channel === 'gui:update-state') sentStates.push(state)
        })
      }
    }

    module.initializeGuiUpdater(
      () => win as never,
      () => 'stable',
      undefined,
      undefined,
      afterQuitAndInstallAbort
    )
    updater.emit('update-downloaded', { version: '0.2.0', releaseDate: '2026-06-06T00:00:00.000Z' })

    await expect(module.installGuiUpdate()).resolves.toEqual({ ok: true })
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)

    await vi.advanceTimersByTimeAsync(12_000)

    expect(module.getGuiUpdateState()).toMatchObject({
      status: 'error',
      code: 'install_failed'
    })
    expect(sentStates).toContainEqual(expect.objectContaining({
      status: 'error',
      code: 'install_failed'
    }))
    expect(afterQuitAndInstallAbort).toHaveBeenCalledTimes(1)
  })

  it('does not report a timeout failure after the app starts quitting for update', async () => {
    const module = await import('./gui-updater')

    module.initializeGuiUpdater(() => null, () => 'stable')
    updater.emit('update-downloaded', { version: '0.2.0', releaseDate: '2026-06-06T00:00:00.000Z' })

    await expect(module.installGuiUpdate()).resolves.toEqual({ ok: true })
    mockApp.emit('before-quit')
    await vi.advanceTimersByTimeAsync(12_000)

    expect(module.getGuiUpdateState()).toMatchObject({
      status: 'installing'
    })
  })
})
