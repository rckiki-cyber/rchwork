import { app, autoUpdater as nativeAutoUpdater, BrowserWindow } from 'electron'
import { constants, createReadStream, existsSync, readFileSync, rmSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import electronUpdater from 'electron-updater'
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import type {
  GuiUpdateChannel,
  GuiUpdateDownloadResult,
  GuiUpdateFailureCode,
  GuiUpdateInfo,
  GuiUpdateInstallResult,
  GuiUpdateState
} from '../shared/gui-update'
import { nextGuiUpdateCheckDelay } from '../shared/gui-update-schedule'
import { DEFAULT_GUI_UPDATE_CHANNEL, normalizeGuiUpdateChannel } from '../shared/gui-update'
import { logInfo, logWarn } from './logger'

const DEFAULT_R2_PUBLIC_BASE_URL = 'https://legalwork.local/api/r2'
const DEFAULT_R2_RELEASE_PREFIX = 'legalwork'
const { autoUpdater } = electronUpdater
const updaterLifecycleEvents = autoUpdater as typeof autoUpdater & {
  on(event: 'before-quit-for-update', listener: () => void): typeof autoUpdater
}

let initialized = false
let getMainWindow: (() => BrowserWindow | null) | null = null
let lastInfo: Extract<GuiUpdateInfo, { ok: true }> | null = null
let lastState: GuiUpdateState = { status: 'idle' }
let downloaded = false
let downloadPromise: Promise<string[]> | null = null
let configuredChannel: GuiUpdateChannel = normalizeGuiUpdateChannel(
  process.env.LEGALWORK_UPDATE_CHANNEL?.trim()
)
let configuredFeedUrl = ''
let getSelectedChannel: (() => GuiUpdateChannel | Promise<GuiUpdateChannel>) | null = null
let beforeInstallUpdate: (() => void | Promise<void>) | null = null
let beforeQuitAndInstallUpdate: (() => void) | null = null
let afterQuitAndInstallAbortUpdate: (() => void) | null = null
let beforeInstallUpdatePromise: Promise<void> | null = null
let backgroundCheckTimer: NodeJS.Timeout | null = null
let backgroundCheckPromise: Promise<void> | null = null
let installExitWatchTimer: NodeJS.Timeout | null = null
let downloadedUpdatePaths: string[] = []
let downloadedUpdateSha512 = ''
let fallbackInstallStarted = false

/** GitHub API mirror for users in regions where GitHub is slow or unreachable. */
const GITHUB_MIRROR_BASE = 'https://ghfast.top/'
/** Per-URL cache: once a mirror works for a URL, skip the direct attempt next time. */
const mirrorCache = new Set<string>()

const GUI_UPDATE_SCHEDULE_FILE = 'gui-update-schedule.json'
const GUI_UPDATE_INSTALL_EXIT_TIMEOUT_MS = 12_000
const MAX_RELEASE_HIGHLIGHTS = 5

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function joinUrl(base: string, ...parts: string[]): string {
  const cleanBase = normalizeBaseUrl(base)
  const cleanParts = parts.map((p) => trimSlashes(p)).filter(Boolean)
  return [cleanBase, ...cleanParts].join('/')
}

function envUpdateUrl(channel: GuiUpdateChannel): string {
  const channelSpecific = process.env[`LEGALWORK_UPDATE_URL_${channel.toUpperCase()}`]?.trim()
  const direct = channelSpecific || process.env.LEGALWORK_UPDATE_URL?.trim() || ''
  return direct ? direct.replace(/\{channel\}/g, channel).replace(/\/?$/, '/') : ''
}

function updateFeedUrl(channel: GuiUpdateChannel): string {
  const direct = envUpdateUrl(channel)
  if (direct) return direct

  return fallbackGenericUpdateUrl(channel)
}

function fallbackGenericUpdateUrl(channel: GuiUpdateChannel): string {
  const base = process.env.R2_PUBLIC_BASE_URL?.trim() || DEFAULT_R2_PUBLIC_BASE_URL
  const prefix = process.env.R2_RELEASE_PREFIX?.trim() || DEFAULT_R2_RELEASE_PREFIX
  return `${joinUrl(base, prefix, 'channels', channel, 'latest')}/`
}

function guiUpdateSchedulePath(): string {
  return join(app.getPath('userData'), GUI_UPDATE_SCHEDULE_FILE)
}

async function readLastScheduledCheckAt(): Promise<number | null> {
  try {
    const raw = await readFile(guiUpdateSchedulePath(), 'utf8')
    const parsed = JSON.parse(raw) as { lastCheckedAt?: unknown }
    const ms = typeof parsed.lastCheckedAt === 'string' ? Date.parse(parsed.lastCheckedAt) : Number.NaN
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

async function writeLastScheduledCheckAt(nowMs: number): Promise<void> {
  const path = guiUpdateSchedulePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({ lastCheckedAt: new Date(nowMs).toISOString() }, null, 2),
    'utf8'
  )
}

function normalizeGithubOwnerRepo(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
  if (s.startsWith('github:')) s = s.slice('github:'.length).trim()
  const ssh = s.match(/^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/i)
  if (ssh?.[1]) return ssh[1].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  const https = s.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:$|[#/])/i)
  if (https?.[1]) return https[1].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s
  return null
}

function packageJsonPaths(): string[] {
  // In packaged apps app.getAppPath() usually points to the asar archive, and
  // Electron's fs patch can read app.asar/package.json. Provide fallbacks so we
  // still resolve the repository field if that path fails.
  return [
    join(app.getAppPath(), 'package.json'),
    join(process.resourcesPath || '', 'app.asar', 'package.json'),
    join(process.resourcesPath || '', 'app', 'package.json')
  ]
}

function readPackageJson(): Record<string, unknown> | null {
  for (const path of packageJsonPaths()) {
    try {
      if (existsSync(path)) {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

function resolveGithubReleaseUrl(): string | null {
  const envRepo = normalizeGithubOwnerRepo(process.env.LEGALWORK_GITHUB_REPO?.trim() ?? '')
  if (envRepo) return `https://github.com/${envRepo}/releases`

  const pkg = readPackageJson()
  const repository = pkg?.repository
  const raw =
    typeof repository === 'string'
      ? repository
      : repository && typeof repository === 'object' && 'url' in repository
        ? String((repository as { url?: unknown }).url ?? '')
        : ''
  const repo = normalizeGithubOwnerRepo(raw)
  return repo ? `https://github.com/${repo}/releases` : null
}

function resolveGithubOwnerRepo(): string | null {
  const releaseUrl = resolveGithubReleaseUrl()
  if (!releaseUrl) return null
  const match = releaseUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases$/i)
  return match?.[1] ?? null
}

function downloadPageUrl(): string {
  const direct = process.env.LEGALWORK_DOWNLOAD_URL?.trim()
  if (direct) return direct

  const githubReleaseUrl = resolveGithubReleaseUrl()
  if (githubReleaseUrl) return githubReleaseUrl

  const pkg = readPackageJson()
  const homepage = typeof pkg?.homepage === 'string' ? pkg.homepage.trim() : ''
  if (homepage) return homepage

  return updateFeedUrl(configuredChannel)
}

function releaseUrlForVersion(version: string): string {
  const page = resolveGithubReleaseUrl() ?? downloadPageUrl()
  if (/github\.com\/.+\/releases\/?$/i.test(page)) {
    return `${page.replace(/\/+$/, '')}/tag/v${version.replace(/^v/i, '')}`
  }
  return page
}

function parseVersionParts(v: string): number[] {
  const cleaned = v.trim().replace(/^v/i, '').replace(/-.*$/, '')
  return cleaned.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function isVersionGreater(latest: string, current: string): boolean {
  const a = parseVersionParts(latest)
  const b = parseVersionParts(current)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return false
}

function platformManifestName(): string {
  if (process.platform === 'darwin') return 'latest-mac.yml'
  if (process.platform === 'linux') return 'latest-linux.yml'
  return 'latest.yml'
}

function parseYamlScalar(source: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`^${escaped}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, 'm'))
  return match?.[1]?.trim() ?? ''
}

function hasCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value)
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, raw: string) => {
    const normalized = raw.toLowerCase()
    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
    }
    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
    }
    const named: Record<string, string> = {
      amp: '&',
      apos: "'",
      gt: '>',
      lt: '<',
      nbsp: ' ',
      quot: '"'
    }
    return named[normalized] ?? entity
  })
}

function htmlReleaseTextToPlainText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(?:h[1-6]|p|div|section|article|blockquote|ul|ol)>/gi, '\n')
    .replace(/<(?:h[1-6]|p|div|section|article|blockquote|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<a\b[^>]*>/gi, '')
    .replace(/<\/a>/gi, '')
    .replace(/<\/?(?:strong|em|b|i|code|span|small|del|s|mark|kbd)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
}

function cleanReleaseLine(line: string): string {
  return htmlReleaseTextToPlainText(line)
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[\s>]*(?:[✅✓✗✘⚠•·▪▫◦●○]\uFE0F?)+\s*/u, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function looksLikeTechnicalReleaseLine(line: string): boolean {
  if (!line || /^https?:\/\//i.test(line)) return true
  if (/^-{3,}$/.test(line)) return true
  if (/^(full changelog|compare|automated release|release artifacts?|assets?)\b/i.test(line)) return true
  if (/^(构建信息|平台|未签名构建)$/i.test(line)) return true
  if (/^(macOS|Windows|Linux)[:：]/i.test(line)) return true
  if (/^(release version|release channel|base version|branch|commit|platform)[:：]/i.test(line)) return true
  if (/^(unsigned build|this is an unsigned build|run this after downloading|or)$/i.test(line)) return true
  if (/^(xattr|npm|node|npx|gh|curl|powershell|bash|sh)\s+/i.test(line)) return true
  if (/^(commits?|sha|checksum|blockmap|latest[-\w]*\.ya?ml)\b/i.test(line)) return true
  if (/\b(commit|sha256|sha512|blockmap|package-lock|pnpm-lock|yarn.lock|tsconfig|eslint|prettier)\b/i.test(line)) {
    return true
  }
  if (/\b(TypeScript|electron-builder|workflow|CI|refactor|chore|deps?|dependencies|build script)\b/i.test(line)) {
    return true
  }
  if (/^(bump|merge pull request|build|ci|chore|refactor|docs?)\b/i.test(line)) return true
  return false
}

function humanizeEnglishReleaseLine(line: string): string {
  const text = line.replace(/^release\s+v?\d+(?:\.\d+)*(?:\s*[-:]\s*)?/i, '').trim()
  const lower = text.toLowerCase()
  const isFix = /\b(fix|fixed|bugfix|bug|crash|failed|failure|fallback)\b/.test(lower)

  if (/auto[- ]?update|updater|update install|update fallback/.test(lower)) {
    return isFix ? '修复了应用更新与安装流程的稳定性问题。' : '应用更新与安装流程有改进。'
  }
  if (/settings?|preferences?/.test(lower)) {
    return isFix ? '修复了设置页相关的使用问题。' : '设置页体验有改进。'
  }
  if (/sidebar|badge/.test(lower) && /update/.test(lower)) {
    return '侧边栏会提示可用的新版本。'
  }
  if (/knowledge[- ]?base|regulation|legal research/.test(lower)) {
    return '法律检索、法规资料或知识库内容有更新。'
  }
  if (/plugin|skill|marketplace/.test(lower)) {
    return '插件技能相关功能有更新。'
  }
  if (/data compliance|redaction|desensiti[sz]e/.test(lower)) {
    return isFix ? '修复了数据合规与脱敏流程中的使用问题。' : '数据合规与脱敏流程有改进。'
  }
  if (/chat|thread|conversation|workspace/.test(lower)) {
    return isFix ? '修复了对话工作台相关的使用问题。' : '对话工作台体验有改进。'
  }
  if (/attachment|upload|file/.test(lower)) {
    return isFix ? '修复了附件和文件处理中的使用问题。' : '附件和文件处理体验有改进。'
  }
  if (/document|write|writing|template/.test(lower)) {
    return '文书写作、模板或文档处理能力有更新。'
  }
  if (/download page|landing|website/.test(lower)) {
    return '下载页和产品介绍内容有更新。'
  }
  if (/windows|macos|mac|linux|installer|install/.test(lower)) {
    return isFix ? '修复了桌面端安装和启动方面的问题。' : '桌面端安装和启动体验有改进。'
  }

  return text
}

function normalizeReleaseHighlight(line: string): string | null {
  const cleaned = cleanReleaseLine(line)
  if (!cleaned || looksLikeTechnicalReleaseLine(cleaned)) return null
  if (/^v?\d+(?:\.\d+){1,3}$/i.test(cleaned)) return null
  if (/^(legalwork\s+)?v?\d+(?:\.\d+){1,3}\b/i.test(cleaned)) return null
  if (/^(更新内容|本次更新|更新日志|what'?s new|changes?|release notes?)[:：]?$/i.test(cleaned)) return null
  const normalized = hasCjk(cleaned) ? cleaned : humanizeEnglishReleaseLine(cleaned)
  if (!normalized || looksLikeTechnicalReleaseLine(normalized)) return null
  return normalized.replace(/[。.]?$/, '。')
}

function releaseTextParts(raw: unknown): string[] {
  if (!raw) return []
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      if (typeof item === 'string') return [item]
      if (item && typeof item === 'object' && 'note' in item) {
        return [String((item as { note?: unknown }).note ?? '')]
      }
      return []
    })
  }
  return []
}

function buildReleaseHighlights(...parts: unknown[]): string[] {
  const seen = new Set<string>()
  const highlights: string[] = []
  for (const part of parts.flatMap(releaseTextParts)) {
    const lines = htmlReleaseTextToPlainText(part).split(/\r?\n/)
    for (const line of lines) {
      const normalized = normalizeReleaseHighlight(line)
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      highlights.push(normalized)
      if (highlights.length >= MAX_RELEASE_HIGHLIGHTS) return highlights
    }
  }
  return highlights
}

type GithubReleasePayload = {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
  prerelease?: boolean
}

async function fetchGithubReleaseHighlights(version: string): Promise<string[]> {
  const repo = resolveGithubOwnerRepo()
  if (!repo) return []

  const cleanVersion = version.trim().replace(/^v/i, '')
  for (const tag of [`v${cleanVersion}`, cleanVersion]) {
    try {
      const res = await fetchWithMirrorFallback(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `legalwork/${app.getVersion()}`
        }
      })
      if (!res.ok) continue
      const release = (await res.json()) as GithubReleasePayload
      return buildReleaseHighlights(release.name, release.body)
    } catch {
      return []
    }
  }
  return []
}

async function enrichGuiInfoWithGithubRelease(
  info: Extract<GuiUpdateInfo, { ok: true }>
): Promise<Extract<GuiUpdateInfo, { ok: true }>> {
  if (info.releaseHighlights?.length) return info
  const releaseHighlights = await fetchGithubReleaseHighlights(info.latestVersion)
  return releaseHighlights.length ? { ...info, releaseHighlights } : info
}

function unsupportedMessage(): string {
  return 'Automatic updates are not supported for this build. Use the download page instead.'
}

function extractHttpStatus(raw: string): number | null {
  const match = raw.match(/\b(\d{3})\b/)
  if (!match) return null
  const status = Number.parseInt(match[1], 10)
  return Number.isFinite(status) ? status : null
}

function sanitizeUpdaterError(raw: string, channel: GuiUpdateChannel): string {
  const message = raw.trim()
  if (!message) {
    return `Could not read GUI update metadata for the ${channel} channel. Open the download page instead.`
  }

  if (/Invalid release object path\./i.test(message)) {
    return `The ${channel} update feed is not published correctly yet. Open the download page instead.`
  }

  if (/Object not found\./i.test(message)) {
    return `The ${channel} update feed is missing release metadata right now. Open the download page instead.`
  }

  const status = extractHttpStatus(message)
  if (status === 400 || status === 404) {
    return `The ${channel} update feed is not available right now. Open the download page instead.`
  }
  if (status === 403) {
    return `The ${channel} update feed denied this request. Open the download page instead.`
  }
  if (status === 429) {
    return `The ${channel} update feed is rate limited right now. Please try again later.`
  }
  if (status && status >= 500) {
    return `The ${channel} update feed is temporarily unavailable. Please try again later.`
  }

  return message.split(/\n(?:Headers:|Data:)/, 1)[0].trim() || message
}

function toGuiInfo(updateInfo: UpdateInfo, hasUpdate: boolean, manualOnly = false): Extract<GuiUpdateInfo, { ok: true }> {
  const latestVersion = updateInfo.version.trim()
  const extra = updateInfo as UpdateInfo & { releaseName?: unknown; releaseNotes?: unknown }
  const releaseHighlights = buildReleaseHighlights(extra.releaseName, extra.releaseNotes)
  return {
    ok: true,
    currentVersion: app.getVersion(),
    latestVersion,
    hasUpdate,
    releaseUrl: releaseUrlForVersion(latestVersion),
    releaseDate: updateInfo.releaseDate,
    ...(releaseHighlights.length ? { releaseHighlights } : {}),
    channel: configuredChannel,
    manualOnly,
    downloaded
  }
}

function emitGuiUpdateState(state: GuiUpdateState): void {
  lastState = state
  const win = getMainWindow?.()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('gui:update-state', state)
}

function clearInstallExitWatch(): void {
  if (!installExitWatchTimer) return
  clearTimeout(installExitWatchTimer)
  installExitWatchTimer = null
}

function abortQuitAndInstall(logMessage: string, detail?: unknown): void {
  afterQuitAndInstallAbortUpdate?.()
  logWarn('gui-update', logMessage, detail)
}

function startInstallExitWatch(): void {
  clearInstallExitWatch()
  installExitWatchTimer = setTimeout(() => {
    installExitWatchTimer = null
    if (lastState.status !== 'installing') return

    void startMacZipFallbackInstall('native updater did not quit in time')
      .then((started) => {
        if (started) return

        const message =
          'legalwork did not quit after starting the update installer. Quit legalwork completely and reopen it, or install the update from the download page.'
        abortQuitAndInstall('GUI update installer did not trigger application quit in time.', {
          version: lastInfo?.latestVersion,
          channel: lastInfo?.channel
        })
        emitGuiUpdateState({
          status: 'error',
          info: lastInfo ?? undefined,
          message,
          code: 'install_failed'
        })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        abortQuitAndInstall('GUI update fallback installer failed to start.', {
          version: lastInfo?.latestVersion,
          channel: lastInfo?.channel,
          message
        })
        emitGuiUpdateState({
          status: 'error',
          info: lastInfo ?? undefined,
          message,
          code: 'install_failed'
        })
      })
  }, GUI_UPDATE_INSTALL_EXIT_TIMEOUT_MS)
}

function markInstallQuitStarted(): void {
  if (lastState.status === 'installing') {
    logInfo('gui-update', 'Application quit started for GUI update installation.')
  }
  clearInstallExitWatch()
}

function runBeforeInstallUpdate(): Promise<void> {
  if (!beforeInstallUpdate) return Promise.resolve()
  if (!beforeInstallUpdatePromise) {
    beforeInstallUpdatePromise = Promise.resolve()
      .then(() => beforeInstallUpdate?.())
      .then(() => undefined)
      .finally(() => {
        beforeInstallUpdatePromise = null
      })
  }
  return beforeInstallUpdatePromise
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function currentAppBundlePath(): string | null {
  const execPath = app.getPath('exe') || process.execPath
  const match = execPath.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)
  return match?.[1] ?? null
}

function updaterCacheDirCandidates(): string[] {
  const candidates = new Set<string>()
  const cacheRoot =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Caches')
        : (process.env.XDG_CACHE_HOME || join(homedir(), '.cache'))
  const appName = typeof app.getName === 'function' ? app.getName() : 'legalwork'
  candidates.add(join(cacheRoot, `${appName}-updater`))
  candidates.add(join(app.getPath('userData'), '__update__'))
  return [...candidates]
}

type PendingMacUpdate = {
  path: string
  sha512: string
}

function pendingUpdateZipFromCache(): PendingMacUpdate | null {
  for (const rawPath of downloadedUpdatePaths) {
    if (rawPath.endsWith('.zip') && existsSync(rawPath) && downloadedUpdateSha512) {
      return { path: rawPath, sha512: downloadedUpdateSha512 }
    }
  }

  for (const cacheDir of updaterCacheDirCandidates()) {
    const pendingDir = join(cacheDir, 'pending')
    const infoPath = join(pendingDir, 'update-info.json')
    try {
      if (existsSync(infoPath)) {
        const info = JSON.parse(readFileSync(infoPath, 'utf8')) as {
          fileName?: unknown
          sha512?: unknown
        }
        const fileName = typeof info.fileName === 'string' ? info.fileName : ''
        const sha512 = typeof info.sha512 === 'string' ? info.sha512.trim() : ''
        const updatePath = fileName ? join(pendingDir, fileName) : ''
        if (
          updatePath.endsWith('.zip') &&
          existsSync(updatePath) &&
          sha512 &&
          (!lastInfo?.latestVersion || fileName.includes(lastInfo.latestVersion))
        ) {
          return { path: updatePath, sha512 }
        }
      }
    } catch {
      // An update without trusted cache metadata must not be installed.
    }
  }

  return null
}

async function sha512File(path: string): Promise<string> {
  const hash = createHash('sha512')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve)
  })
  return hash.digest('base64')
}

async function writeMacFallbackInstallScript(
  zipPath: string,
  targetApp: string,
  expectedVersion: string
): Promise<string> {
  const scriptDir = await mkdtemp(join(tmpdir(), 'legalwork-gui-update-'))
  const scriptPath = join(scriptDir, 'install-mac-update.sh')
  const logDir = join(app.getPath('userData'), 'logs')
  const logPath = join(logDir, 'gui-update-install.log')
  await mkdir(logDir, { recursive: true })

  const script = `#!/bin/bash
set -u

ZIP=${shellQuote(zipPath)}
TARGET=${shellQuote(targetApp)}
EXPECTED_VERSION=${shellQuote(expectedVersion)}
EXPECTED_ARCH=${shellQuote(process.arch === 'arm64' ? 'arm64' : 'x86_64')}
APP_PID=${process.pid}
LOG=${shellQuote(logPath)}
STAGE="\${TMPDIR:-/tmp}/legalwork-update-stage-$$"
BACKUP="\${TMPDIR:-/tmp}/legalwork-update-backup-$$-$(basename "$TARGET")"
PLIST_BUDDY=/usr/libexec/PlistBuddy

exec >> "$LOG" 2>&1
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] unsigned macOS updater started"
echo "zip=$ZIP"
echo "target=$TARGET"
echo "expectedVersion=$EXPECTED_VERSION"

cleanup_stage() {
  rm -rf "$STAGE"
}
trap cleanup_stage EXIT

for _ in $(seq 1 50); do
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if kill -0 "$APP_PID" >/dev/null 2>&1; then
  echo "app still running, sending SIGTERM"
  kill "$APP_PID" >/dev/null 2>&1 || true
  sleep 1
fi

if kill -0 "$APP_PID" >/dev/null 2>&1; then
  echo "app still running after SIGTERM; aborting"
  exit 20
fi

rm -rf "$STAGE"
mkdir -p "$STAGE"
if ! ditto -x -k "$ZIP" "$STAGE"; then
  echo "failed to extract update zip"
  exit 21
fi
NEW_APP=$(find "$STAGE" -maxdepth 1 -name "*.app" -type d | head -n 1)
if [ -z "$NEW_APP" ]; then
  echo "no .app bundle found in update zip"
  exit 22
fi

CURRENT_ID=$("$PLIST_BUDDY" -c "Print :CFBundleIdentifier" "$TARGET/Contents/Info.plist" 2>/dev/null || true)
NEW_ID=$("$PLIST_BUDDY" -c "Print :CFBundleIdentifier" "$NEW_APP/Contents/Info.plist" 2>/dev/null || true)
NEW_VERSION=$("$PLIST_BUDDY" -c "Print :CFBundleShortVersionString" "$NEW_APP/Contents/Info.plist" 2>/dev/null || true)
NEW_EXECUTABLE=$("$PLIST_BUDDY" -c "Print :CFBundleExecutable" "$NEW_APP/Contents/Info.plist" 2>/dev/null || true)

if [ -z "$CURRENT_ID" ] || [ "$NEW_ID" != "$CURRENT_ID" ]; then
  echo "bundle identifier mismatch: current=$CURRENT_ID update=$NEW_ID"
  exit 23
fi
if [ -z "$EXPECTED_VERSION" ] || [ "$NEW_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "version mismatch: expected=$EXPECTED_VERSION update=$NEW_VERSION"
  exit 24
fi
if [ -z "$NEW_EXECUTABLE" ] || [ ! -f "$NEW_APP/Contents/MacOS/$NEW_EXECUTABLE" ]; then
  echo "updated app executable is missing"
  exit 25
fi
ARCHS=$(lipo -archs "$NEW_APP/Contents/MacOS/$NEW_EXECUTABLE" 2>/dev/null || true)
case " $ARCHS " in
  *" $EXPECTED_ARCH "*) ;;
  *) echo "architecture mismatch: expected=$EXPECTED_ARCH update=$ARCHS"; exit 26 ;;
esac

# Unsigned releases are still ad-hoc signed by electron-builder. This verifies
# that no sealed file was corrupted after packaging without requiring a paid
# Developer ID certificate.
if ! codesign --verify --deep --strict "$NEW_APP"; then
  echo "updated app failed code integrity verification"
  exit 27
fi

# Never strip quarantine here. If a future download path adds it, macOS should
# retain control and the failure must be visible instead of bypassing Gatekeeper.
if xattr -p com.apple.quarantine "$NEW_APP" >/dev/null 2>&1; then
  echo "updated app is quarantined; refusing to bypass macOS security"
  exit 28
fi

rm -rf "$BACKUP"
if [ -d "$TARGET" ]; then
  if ! mv "$TARGET" "$BACKUP"; then
    echo "failed to move current app to backup"
    exit 29
  fi
fi
if ! mv "$NEW_APP" "$TARGET"; then
  echo "failed to move updated app into place; restoring previous app"
  if [ -d "$BACKUP" ]; then
    mv "$BACKUP" "$TARGET"
  fi
  exit 30
fi

if ! open "$TARGET"; then
  echo "updated app failed to launch; restoring previous app"
  rm -rf "$TARGET"
  if [ -d "$BACKUP" ]; then
    mv "$BACKUP" "$TARGET"
    open "$TARGET" >/dev/null 2>&1 || true
  fi
  exit 31
fi
rm -rf "$BACKUP"
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] unsigned macOS updater completed"
`

  await writeFile(scriptPath, script, 'utf8')
  await chmod(scriptPath, 0o755)
  return scriptPath
}

async function startMacZipFallbackInstall(reason: string): Promise<boolean> {
  if (fallbackInstallStarted || process.platform !== 'darwin') return false
  const targetApp = currentAppBundlePath()
  const pendingUpdate = pendingUpdateZipFromCache()
  const expectedVersion = lastInfo?.latestVersion?.trim() ?? ''
  if (!targetApp || !pendingUpdate || !expectedVersion) return false

  fallbackInstallStarted = true
  try {
    await access(dirname(targetApp), constants.W_OK)
    const actualSha512 = await sha512File(pendingUpdate.path)
    if (actualSha512 !== pendingUpdate.sha512) {
      throw new Error('The downloaded macOS update failed SHA-512 verification.')
    }
    const scriptPath = await writeMacFallbackInstallScript(
      pendingUpdate.path,
      targetApp,
      expectedVersion
    )
    logWarn('gui-update', 'Starting macOS zip fallback installer.', {
      reason,
      version: lastInfo?.latestVersion,
      channel: lastInfo?.channel,
      zipPath: pendingUpdate.path,
      targetApp
    })
    const child = spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    app.quit()
    return true
  } catch (error) {
    fallbackInstallStarted = false
    throw error
  }
}

function clearBackgroundCheckTimer(): void {
  if (backgroundCheckTimer) {
    clearTimeout(backgroundCheckTimer)
    backgroundCheckTimer = null
  }
}

function shouldSkipScheduledCheck(): boolean {
  return (
    lastState.status === 'checking' ||
    lastState.status === 'downloading' ||
    lastState.status === 'downloaded' ||
    lastState.status === 'installing'
  )
}

async function scheduleNextBackgroundCheck(): Promise<void> {
  clearBackgroundCheckTimer()
  const lastCheckedAtMs = await readLastScheduledCheckAt()
  const delay = nextGuiUpdateCheckDelay(lastCheckedAtMs)
  backgroundCheckTimer = setTimeout(() => {
    void runScheduledGuiUpdateCheck()
  }, delay)
}

async function runScheduledGuiUpdateCheck(): Promise<void> {
  if (backgroundCheckPromise) return backgroundCheckPromise
  backgroundCheckPromise = (async () => {
    try {
      if (shouldSkipScheduledCheck()) return
      const nowMs = Date.now()
      await writeLastScheduledCheckAt(nowMs)
      await checkGuiUpdate()
    } catch (error) {
      console.warn('[legalwork updater] scheduled GUI update check failed:', error)
    } finally {
      backgroundCheckPromise = null
      void scheduleNextBackgroundCheck()
    }
  })()
  return backgroundCheckPromise
}

async function resolveUpdateChannel(requested?: GuiUpdateChannel): Promise<GuiUpdateChannel> {
  if (requested) return normalizeGuiUpdateChannel(requested)
  if (getSelectedChannel) {
    return normalizeGuiUpdateChannel(await getSelectedChannel())
  }
  return DEFAULT_GUI_UPDATE_CHANNEL
}

function configureUpdaterChannel(channel: GuiUpdateChannel): void {
  const normalized = normalizeGuiUpdateChannel(channel)
  const directFeedUrl = envUpdateUrl(normalized)
  const repo = directFeedUrl ? null : resolveGithubOwnerRepo()
  const feedUrl = directFeedUrl || (repo ? `github:${repo}` : fallbackGenericUpdateUrl(normalized))
  const changed = normalized !== configuredChannel || feedUrl !== configuredFeedUrl
  configuredChannel = normalized
  configuredFeedUrl = feedUrl
  autoUpdater.allowPrerelease = normalized === 'frontier'
  if (repo) {
    const [owner, repoName] = repo.split('/')
    autoUpdater.setFeedURL({
      provider: 'github',
      owner,
      repo: repoName
    })
  } else {
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
  }
  if (!changed) return
  downloaded = false
  downloadPromise = null
  downloadedUpdatePaths = []
  fallbackInstallStarted = false
  lastInfo = null
  emitGuiUpdateState({ status: 'idle' })
}

export function setGuiUpdateChannel(channel: GuiUpdateChannel): void {
  configureUpdaterChannel(channel)
}

/**
 * Fetch a URL with automatic mirror fallback for GitHub URLs.
 *
 * 1. If the URL was previously served successfully by the mirror, go directly to the mirror.
 * 2. Otherwise, try the original URL with a 6-second timeout.
 * 3. If the original fails (timeout / network error / 404), retry via `GITHUB_MIRROR_BASE`.
 * 4. Cache the mirror success so subsequent checks skip the direct attempt.
 *
 * This lets VPN users fetch at full speed while Chinese users without VPN
 * get a working fallback with only a few seconds of delay.
 */
const FETCH_TIMEOUT_MS = 6_000

async function fetchWithMirrorFallback(url: string, init?: RequestInit): Promise<Response> {
  const mirrorUrl = url.startsWith('https://api.github.com/') || url.startsWith('https://github.com/')
    ? `${GITHUB_MIRROR_BASE}${url}`
    : null

  // If mirror previously worked for this URL, skip direct and use mirror directly
  if (mirrorUrl && mirrorCache.has(url)) {
    const res = await fetch(mirrorUrl, init)
    if (res.ok) return res
    mirrorCache.delete(url)
  }

  // Try direct first
  if (!mirrorUrl) return fetch(url, init)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    clearTimeout(timer)
    return res
  } catch {
    clearTimeout(timer)
    // Fallback to mirror
    const res = await fetch(mirrorUrl, init)
    if (res.ok) mirrorCache.add(url)
    return res
  }
}

async function resolveGithubManifestUrl(channel: GuiUpdateChannel): Promise<string | null> {
  const repo = resolveGithubOwnerRepo()
  if (!repo) return null

  if (channel === 'stable') {
    return `https://github.com/${repo}/releases/latest/download/${platformManifestName()}`
  }

  // frontier: GitHub releases do not have a /latest/download for prereleases,
  // so we query the API and pick the newest prerelease tag.
  const apiUrl = `https://api.github.com/repos/${repo}/releases`
  try {
    const res = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `legalwork/${app.getVersion()}`
      }
    })
    if (!res.ok) return null
    const releases = (await res.json()) as Array<{ prerelease: boolean; tag_name: string }>
    const pre = releases.find((r) => r.prerelease)
    if (!pre) return null
    return `https://github.com/${repo}/releases/download/${pre.tag_name}/${platformManifestName()}`
  } catch {
    return null
  }
}

/**
 * Fallback update check that uses the GitHub Releases API directly.
 * This lets the UI report "up to date" / "update available" even when the
 * updater manifest YAML files (latest-*.yml) are missing from the release.
 * Downloads still require the manifest, so results are marked manualOnly.
 */
async function checkGithubApiUpdate(channel: GuiUpdateChannel): Promise<GuiUpdateInfo | null> {
  const repo = resolveGithubOwnerRepo()
  if (!repo) return null

  const currentVersion = app.getVersion()
  try {
    let tagName: string | undefined
    let releaseDate: string | undefined
    let releaseName: string | undefined
    let releaseBody: string | undefined

    if (channel === 'stable') {
      const res = await fetchWithMirrorFallback(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `legalwork/${currentVersion}`
        }
      })
      if (!res.ok) return null
      const release = (await res.json()) as GithubReleasePayload
      tagName = release.tag_name
      releaseDate = release.published_at
      releaseName = release.name
      releaseBody = release.body
    } else {
      const res = await fetchWithMirrorFallback(`https://api.github.com/repos/${repo}/releases`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `legalwork/${currentVersion}`
        }
      })
      if (!res.ok) return null
      const releases = (await res.json()) as GithubReleasePayload[]
      const pre = releases.find((r) => r.prerelease)
      if (!pre) return null
      tagName = pre.tag_name
      releaseDate = pre.published_at
      releaseName = pre.name
      releaseBody = pre.body
    }

    if (!tagName) return null
    const latestVersion = tagName.trim().replace(/^v/i, '')
    const releaseHighlights = buildReleaseHighlights(releaseName, releaseBody)
    const info: Extract<GuiUpdateInfo, { ok: true }> = {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate: isVersionGreater(latestVersion, currentVersion),
      releaseUrl: releaseUrlForVersion(latestVersion),
      releaseDate,
      ...(releaseHighlights.length ? { releaseHighlights } : {}),
      channel,
      manualOnly: true,
      downloaded: false
    }
    lastInfo = info
    emitGuiUpdateState(info.hasUpdate ? { status: 'available', info } : { status: 'not_available', info })
    return info
  } catch {
    return null
  }
}

async function checkManualUpdate(
  channel: GuiUpdateChannel,
  code: GuiUpdateFailureCode = 'unsupported'
): Promise<GuiUpdateInfo> {
  const currentVersion = app.getVersion()
  try {
    const url = (await resolveGithubManifestUrl(channel)) ?? `${updateFeedUrl(channel)}${platformManifestName()}`
    const res = await fetchWithMirrorFallback(url, {
      headers: {
        Accept: 'application/x-yaml,text/yaml,text/plain,*/*',
        'User-Agent': `legalwork/${currentVersion}`
      }
    })
    if (!res.ok) {
      return {
        ok: false,
        currentVersion,
        code,
        message: `${unsupportedMessage()} Update metadata returned ${res.status}.`,
        releaseUrl: downloadPageUrl(),
        channel
      }
    }
    const text = await res.text()
    const latestVersion = parseYamlScalar(text, 'version')
    if (!latestVersion) {
      return {
        ok: false,
        currentVersion,
        code,
        message: `${unsupportedMessage()} Update metadata is missing a version.`,
        releaseUrl: downloadPageUrl(),
        channel
      }
    }
    const releaseHighlights = await fetchGithubReleaseHighlights(latestVersion)
    const info: Extract<GuiUpdateInfo, { ok: true }> = {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate: isVersionGreater(latestVersion, currentVersion),
      releaseUrl: releaseUrlForVersion(latestVersion),
      releaseDate: parseYamlScalar(text, 'releaseDate'),
      ...(releaseHighlights.length ? { releaseHighlights } : {}),
      channel,
      manualOnly: true,
      downloaded: false
    }
    lastInfo = info
    emitGuiUpdateState(info.hasUpdate ? { status: 'available', info } : { status: 'not_available', info })
    return info
  } catch (e) {
    return {
      ok: false,
      currentVersion,
      code,
      message: `${unsupportedMessage()} ${e instanceof Error ? e.message : String(e)}`,
      releaseUrl: downloadPageUrl(),
      channel
    }
  }
}

function fileNameContainsVersion(fileName: string, version: string): boolean {
  if (!fileName || !version) return false
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^0-9])${escapedVersion}(?:[^0-9]|$)`).test(fileName)
}

/**
 * Remove an update package after that same version has successfully launched.
 *
 * electron-updater stores the downloaded package under `<cache>/pending` and,
 * on macOS, keeps a second `<cache>/update.zip` for future differential
 * downloads. Keep the differential cache, but discard the now-installed
 * pending copy so every successful update does not occupy two ZIP-sized files.
 */
function cleanupInstalledUpdatePackage(): void {
  const currentVersion = app.getVersion().trim()
  if (!currentVersion) return

  for (const cacheDir of updaterCacheDirCandidates()) {
    const pendingDir = join(cacheDir, 'pending')
    const infoPath = join(pendingDir, 'update-info.json')
    try {
      if (!existsSync(infoPath)) continue
      const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { fileName?: unknown }
      const fileName = typeof info.fileName === 'string' ? info.fileName : ''
      if (!fileNameContainsVersion(fileName, currentVersion)) continue

      rmSync(pendingDir, { recursive: true, force: true })
      logInfo(
        'gui-update',
        `Removed the pending package for installed GUI version ${currentVersion}.`
      )
    } catch {
      // Best-effort cleanup. The updater validates or replaces malformed cache
      // metadata the next time an update is downloaded.
    }
  }
}

export function initializeGuiUpdater(
  windowGetter: () => BrowserWindow | null,
  channelGetter?: () => GuiUpdateChannel | Promise<GuiUpdateChannel>,
  beforeInstall?: () => void | Promise<void>,
  beforeQuitAndInstall?: () => void,
  afterQuitAndInstallAbort?: () => void
): void {
  getMainWindow = windowGetter
  getSelectedChannel = channelGetter ?? null
  beforeInstallUpdate = beforeInstall ?? null
  beforeQuitAndInstallUpdate = beforeQuitAndInstall ?? null
  afterQuitAndInstallAbortUpdate = afterQuitAndInstallAbort ?? null
  if (initialized) return
  initialized = true

  cleanupInstalledUpdatePackage()

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  configureUpdaterChannel(configuredChannel)
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
  }

  autoUpdater.logger = {
    info: (message?: unknown) => console.info('[legalwork updater]', message),
    warn: (message?: unknown) => console.warn('[legalwork updater]', message),
    error: (message?: unknown) => console.error('[legalwork updater]', message)
  }

  autoUpdater.on('checking-for-update', () => {
    emitGuiUpdateState({ status: 'checking', info: lastInfo ?? undefined })
  })

  autoUpdater.on('update-available', (updateInfo: UpdateInfo) => {
    downloaded = false
    downloadedUpdatePaths = []
    downloadedUpdateSha512 = ''
    fallbackInstallStarted = false
    const info = toGuiInfo(updateInfo, true)
    lastInfo = info
    emitGuiUpdateState({ status: 'available', info })
    void enrichGuiInfoWithGithubRelease(info).then((enriched) => {
      if (lastInfo?.latestVersion !== enriched.latestVersion) return
      if (lastState.status !== 'available') return
      lastInfo = enriched
      emitGuiUpdateState({ status: 'available', info: enriched })
    })
  })

  autoUpdater.on('update-not-available', (updateInfo: UpdateInfo) => {
    downloaded = false
    downloadedUpdatePaths = []
    downloadedUpdateSha512 = ''
    fallbackInstallStarted = false
    const info = toGuiInfo(updateInfo, false)
    lastInfo = info
    emitGuiUpdateState({ status: 'not_available', info })
    void enrichGuiInfoWithGithubRelease(info).then((enriched) => {
      if (lastInfo?.latestVersion !== enriched.latestVersion) return
      if (lastState.status !== 'not_available') return
      lastInfo = enriched
      emitGuiUpdateState({ status: 'not_available', info: enriched })
    })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    emitGuiUpdateState({ status: 'downloading', info: lastInfo ?? undefined, progress })
  })

  autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    downloaded = true
    const downloadedFile = typeof event.downloadedFile === 'string' ? event.downloadedFile : ''
    downloadedUpdatePaths = downloadedFile ? [downloadedFile] : downloadedUpdatePaths
    const downloadedFileName = downloadedFile ? basename(downloadedFile) : ''
    const downloadedFileInfo = event.files?.find((file) => {
      const fileName = basename(file.url)
      return fileName === downloadedFileName || (!downloadedFileName && fileName.endsWith('.zip'))
    })
    downloadedUpdateSha512 = downloadedFileInfo?.sha512?.trim() || event.sha512?.trim() || ''
    fallbackInstallStarted = false
    const info = toGuiInfo(event, true)
    lastInfo = info
    emitGuiUpdateState({ status: 'downloaded', info })
    void enrichGuiInfoWithGithubRelease(info).then((enriched) => {
      if (lastInfo?.latestVersion !== enriched.latestVersion) return
      if (lastState.status !== 'downloaded') return
      lastInfo = { ...enriched, downloaded: true }
      emitGuiUpdateState({ status: 'downloaded', info: lastInfo })
    })
  })

  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    // When the release is missing the files electron-updater expects (e.g. no
    // mac zip, only dmgs), fall back to the GitHub API so the UI can at least
    // show "up to date" or "update available (manual)" instead of an error.
    if (resolveGithubOwnerRepo() && /ZIP file not provided|Cannot download|sha512 checksum mismatch|ENOENT.*app-update\.yml|app-update\.yml.*ENOENT/i.test(message)) {
      void checkGithubApiUpdate(configuredChannel).then((info) => {
        if (!info) {
          emitGuiUpdateState({ status: 'error', info: lastInfo ?? undefined, message, code: 'unknown' })
        }
      })
      return
    }
    emitGuiUpdateState({ status: 'error', info: lastInfo ?? undefined, message, code: 'unknown' })
  })

  nativeAutoUpdater?.on?.('before-quit-for-update', () => {
    markInstallQuitStarted()
    void runBeforeInstallUpdate().catch((error) => {
      console.warn('[legalwork updater] failed to stop runtimes before update quit:', error)
    })
  })

  updaterLifecycleEvents.on('before-quit-for-update', () => {
    markInstallQuitStarted()
  })

  app.on('before-quit', markInstallQuitStarted)
  app.on('will-quit', markInstallQuitStarted)

  void scheduleNextBackgroundCheck()
}

export function getGuiUpdateState(): GuiUpdateState {
  return lastState
}

export async function checkGuiUpdate(channel?: GuiUpdateChannel): Promise<GuiUpdateInfo> {
  const selectedChannel = await resolveUpdateChannel(channel)
  configureUpdaterChannel(selectedChannel)

  emitGuiUpdateState({ status: 'checking', info: lastInfo ?? undefined })
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      return checkManualUpdate(selectedChannel, 'not_configured')
    }
    const info = await enrichGuiInfoWithGithubRelease(
      toGuiInfo(result.updateInfo, result.isUpdateAvailable)
    )
    lastInfo = info
    emitGuiUpdateState(info.hasUpdate ? { status: 'available', info } : { status: 'not_available', info })
    return info
  } catch (e) {
    const rawMessage = e instanceof Error ? e.message : String(e)
    const githubApiInfo = await checkGithubApiUpdate(selectedChannel)
    if (githubApiInfo) return githubApiInfo

    const message = sanitizeUpdaterError(rawMessage, selectedChannel)
    const info: GuiUpdateInfo = {
      ok: false,
      currentVersion: app.getVersion(),
      message,
      code: 'unknown',
      releaseUrl: downloadPageUrl(),
      channel: selectedChannel
    }
    emitGuiUpdateState({ status: 'error', info, message, code: 'unknown' })
    return info
  }
}

export async function downloadGuiUpdate(channel?: GuiUpdateChannel): Promise<GuiUpdateDownloadResult> {
  const selectedChannel = await resolveUpdateChannel(channel)
  configureUpdaterChannel(selectedChannel)

  try {
    if (!lastInfo?.hasUpdate || lastInfo.channel !== selectedChannel || lastInfo.manualOnly) {
      const checked = await checkGuiUpdate(selectedChannel)
      if (!checked.ok) return checked
      if (!checked.hasUpdate || checked.manualOnly) {
        return {
          ok: false,
          currentVersion: app.getVersion(),
          code: checked.manualOnly ? 'unsupported' : 'unknown',
          message: checked.manualOnly
            ? unsupportedMessage()
            : 'No downloadable GUI update is available.'
        }
      }
    }

    if (downloaded) {
      return { ok: true, paths: [] }
    }

    if (!downloadPromise) {
      downloadPromise = autoUpdater.downloadUpdate().finally(() => {
        downloadPromise = null
      })
    }
    const paths = await downloadPromise
    downloadedUpdatePaths = paths.filter((path) => path.endsWith('.zip') && existsSync(path))
    return { ok: true, paths }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    emitGuiUpdateState({ status: 'error', info: lastInfo ?? undefined, message, code: 'download_failed' })
    return {
      ok: false,
      currentVersion: app.getVersion(),
      code: 'download_failed',
      message
    }
  }
}

export async function installGuiUpdate(): Promise<GuiUpdateInstallResult> {
  try {
    if (!downloaded) {
      return {
        ok: false,
        currentVersion: app.getVersion(),
        code: 'install_failed',
        message: 'The update has not finished downloading yet.'
      }
    }
    emitGuiUpdateState({ status: 'installing', info: lastInfo ?? undefined })
    await runBeforeInstallUpdate()
    beforeQuitAndInstallUpdate?.()

    // electron-updater's macOS path downloads the ZIP first, then asks the
    // native Squirrel updater to fetch the same update through a temporary
    // localhost proxy. In production that second `update-downloaded` event can
    // fail to arrive, so quitAndInstall() returns without quitting or
    // installing anything. Use the already downloaded and checksum-verified
    // ZIP directly instead of depending on that second, unreliable hand-off.
    if (process.platform === 'darwin') {
      const started = await startMacZipFallbackInstall('direct install of downloaded macOS update')
      if (started) return { ok: true }
      throw new Error(
        'The downloaded macOS update is missing trusted ZIP metadata. Download the update again or use the download page.'
      )
    }

    startInstallExitWatch()
    logInfo('gui-update', 'Calling quitAndInstall for GUI update.')
    autoUpdater.quitAndInstall(false, true)
    return { ok: true }
  } catch (e) {
    clearInstallExitWatch()
    const message = e instanceof Error ? e.message : String(e)
    abortQuitAndInstall('GUI update installation failed before quitAndInstall.', { message })
    emitGuiUpdateState({ status: 'error', info: lastInfo ?? undefined, message, code: 'install_failed' })
    return {
      ok: false,
      currentVersion: app.getVersion(),
      code: 'install_failed',
      message
    }
  }
}
