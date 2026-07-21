import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { AppSettingsV1 } from '../../shared/app-settings'
import { expandHomePath } from './workspace-service'

export type GuiSkillScope = 'project' | 'global' | 'builtin'
const execFileAsync = promisify(execFile)
export const USER_INSTALLED_SKILL_ROOT = join(homedir(), '.legalwork', 'skills')

function isPackagedApp(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as { app?: { isPackaged?: boolean } }
    return app?.isPackaged === true
  } catch {
    return false
  }
}

function getElectronAppPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as { app: { getAppPath: () => string } }
    return app.getAppPath()
  } catch {
    return undefined
  }
}

export function resolveBuiltinSkillsRoot(): string | undefined {
  if (!isPackagedApp()) {
    const appPath = getElectronAppPath()
    const candidates = appPath
      ? [resolve(appPath, '../../skills')]
      : [resolve(process.cwd(), '../../skills')]
    return candidates.find((candidate) => existsSync(candidate))
  }
  const resourcesPath = process.resourcesPath ?? dirname(process.execPath)
  const candidates = [
    join(resourcesPath, 'skills'),
    join(resourcesPath, 'app.asar.unpacked', 'skills')
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

export type GuiSkillSummary = {
  id: string
  name: string
  description?: string
  root: string
  entryPath: string
  scope: GuiSkillScope
  legacy: boolean
  userInstalled?: boolean
}

export type GuiSkillListResult =
  | { ok: true; skills: GuiSkillSummary[]; validationErrors: Array<{ root: string; message: string }> }
  | { ok: false; message: string }

export type GuiSkillReadResult =
  | { ok: true; path: string; content: string }
  | { ok: false; message: string }

export type GuiSkillRoot = {
  path: string
  scope: GuiSkillScope
}

export type GuiSkillImportResult =
  | {
      ok: true
      userSkillRoot: string
      installed: Array<{
        name: string
        path: string
        replaced: boolean
      }>
    }
  | { ok: false; message: string }

const SKILL_PACKAGE_SCAN_DEPTH = 5

export async function guiSkillRootsForRuntime(
  settings: AppSettingsV1 | undefined,
  workspaceRootOverride?: string
): Promise<GuiSkillRoot[]> {
  if (!settings && !workspaceRootOverride) return []
  const workspaceRoots = uniqueStrings([
    workspaceRootOverride,
    settings?.workspaceRoot,
    settings?.claw.im.workspaceRoot,
    settings?.schedule.defaultWorkspaceRoot,
    ...(settings?.claw.channels.map((channel) => channel.workspaceRoot) ?? []),
    ...(settings?.claw.tasks.map((task) => task.workspaceRoot) ?? []),
    ...(settings?.schedule.tasks.map((task) => task.workspaceRoot) ?? [])
  ].map(normalizeSkillRootPath).filter(Boolean))
  const projectRoots = workspaceRoots.flatMap((workspaceRoot) => [
    join(workspaceRoot, '.codex', 'skills'),
    join(workspaceRoot, '.agents', 'skills'),
    join(workspaceRoot, 'skills')
  ])
  const globalRoots: string[] = [
    join(homedir(), '.agents', 'skills'),
    USER_INSTALLED_SKILL_ROOT,
    ...await discoverCodexPluginSkillRoots(),
    ...await discoverComputerWideSkillRoots()
  ]
  const configuredExtraRoots: string[] = [
    ...(settings?.claw.skills.extraDirs ?? []),
    ...(settings?.schedule.skills.extraDirs ?? [])
  ].map(normalizeSkillRootPath)
  const builtinRoot = resolveBuiltinSkillsRoot()

  return uniqueSkillRoots([
    ...projectRoots
      .filter((root) => existsSync(root))
      .map((path) => ({ path, scope: 'project' as const })),
    ...globalRoots
      .filter((root) => existsSync(root))
      .map((path) => ({ path, scope: 'global' as const })),
    ...configuredExtraRoots
      .filter(Boolean)
      .map((path) => ({ path, scope: scopeForConfiguredRoot(path, workspaceRoots) })),
    ...(builtinRoot ? [{ path: builtinRoot, scope: 'builtin' as const }] : [])
  ])
}

export async function listGuiSkills(
  settings: AppSettingsV1,
  workspaceRootOverride?: string
): Promise<GuiSkillListResult> {
  try {
    const roots = await guiSkillRootsForRuntime(settings, workspaceRootOverride)
    const skills: GuiSkillSummary[] = []
    const validationErrors: Array<{ root: string; message: string }> = []
    for (const root of roots) {
      const candidates = await packageCandidates(root.path, SKILL_PACKAGE_SCAN_DEPTH).catch((error) => {
        validationErrors.push({ root: root.path, message: errorMessage(error) })
        return []
      })
      for (const candidate of candidates) {
        const loaded = await loadSkillSummary(candidate, root.scope).catch((error) => {
          validationErrors.push({ root: candidate, message: errorMessage(error) })
          return null
        })
        if (loaded) skills.push(loaded)
      }
    }
    return {
      ok: true,
      skills: dedupeSkills(skills),
      validationErrors
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export async function readGuiSkillFile(rootPath: string, entryPath: string): Promise<GuiSkillReadResult> {
  try {
    const root = resolve(expandHomePath(rootPath))
    const entry = resolve(expandHomePath(entryPath))
    const [rootReal, entryReal] = await Promise.all([
      realpath(root),
      realpath(entry)
    ])
    const relativePath = relative(rootReal, entryReal)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return { ok: false, message: 'Skill file must be inside the Skill directory.' }
    }
    const ext = extname(entryReal).toLowerCase()
    if (ext !== '.md' && ext !== '.markdown') {
      return { ok: false, message: 'Only Markdown Skill previews are supported.' }
    }
    const fileStat = await stat(entryReal)
    if (!fileStat.isFile()) {
      return { ok: false, message: 'Skill preview target is not a file.' }
    }
    if (fileStat.size > 1_000_000) {
      return { ok: false, message: 'Skill file is too large to preview.' }
    }
    return {
      ok: true,
      path: entryReal,
      content: await readFile(entryReal, 'utf8')
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export async function importGuiSkillFromPath(
  sourcePath: string,
  targetRoot = USER_INSTALLED_SKILL_ROOT
): Promise<GuiSkillImportResult> {
  try {
    const source = resolve(expandHomePath(sourcePath))
    if (!source || !existsSync(source)) {
      return { ok: false, message: '请选择有效的 Skill 文件夹或 zip 文件。' }
    }

    const sourceStat = await stat(source)
    let tempDir = ''
    const importRoot = sourceStat.isDirectory()
      ? source
      : isZipFile(source)
        ? await extractSkillZip(source).then((dir) => {
            tempDir = dir
            return dir
          })
        : ''

    if (!importRoot) {
      return { ok: false, message: '仅支持 Skill 文件夹或 .zip 文件。' }
    }

    try {
      const skillDirs = await importSkillCandidates(importRoot)
      if (skillDirs.length === 0) {
        return { ok: false, message: '未找到 SKILL.md 或 skill.json。' }
      }

      await mkdir(targetRoot, { recursive: true })
      const installed = []
      for (const skillDir of skillDirs) {
        installed.push(await installSkillDirectory(skillDir, targetRoot))
      }
      return {
        ok: true,
        userSkillRoot: targetRoot,
        installed
      }
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true })
      }
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export function normalizeSkillRootPath(path: string | undefined): string {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return ''
  return resolve(expandHomePath(trimmed))
}

function isHiddenDirectory(name: string): boolean {
  return name.startsWith('.') && name !== '.codex' && name !== '.agents'
}

// macOS TCC 受保护位置：读取 ~/Pictures、~/Music、~/Movies 或系统媒体库包
// （如 Photos Library.photoslibrary）会触发相册 / 媒体库权限弹窗。Skill 根目录
// 不可能位于这些位置，扫描时直接跳过，避免首次启动弹出与功能无关的权限请求。
const MACOS_PROTECTED_MEDIA_DIRS = new Set(['Pictures', 'Music', 'Movies'])
const MACOS_LIBRARY_PACKAGE_EXTENSIONS = [
  '.photoslibrary',
  '.photolibrary',
  '.musiclibrary',
  '.itlibrary',
  '.aplibrary',
  '.tvlibrary',
  '.imovielibrary'
]

export function shouldSkipSkillScanEntry(root: string, name: string): boolean {
  const lower = name.toLowerCase()
  if (MACOS_LIBRARY_PACKAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true
  return root === homedir() && MACOS_PROTECTED_MEDIA_DIRS.has(name)
}

async function discoverComputerWideSkillRoots(): Promise<string[]> {
  const roots: string[] = []
  const userHome = homedir()
  const knownPaths = [
    join(userHome, '.claude', 'skills'),
    join(userHome, '.codex', 'skills'),
    join(userHome, '.agents', 'skills'),
    join(userHome, '.legalwork', 'skills'),
    join(userHome, 'skills'),
    '/usr/local/share/skills',
    '/opt/skills'
  ]
  for (const path of knownPaths) {
    if (existsSync(path) && skillRootHasPackages(path)) {
      roots.push(path)
    }
  }
  const scanRoots = [
    userHome,
    join(userHome, 'Documents'),
    join(userHome, 'Projects'),
    join(userHome, 'Workspace')
  ]
  const discovered = (await Promise.all(
    scanRoots.map(async (root) => {
      if (!existsSync(root)) return []
      try {
        return await findSkillRootsUnder(root, 2)
      } catch {
        return []
      }
    })
  )).flat()
  for (const path of discovered) {
    if (!roots.some((r) => comparablePath(r) === comparablePath(path))) {
      roots.push(path)
    }
  }
  return roots
}

async function findSkillRootsUnder(root: string, maxDepth: number): Promise<string[]> {
  const results: string[] = []
  if (maxDepth <= 0) return results
  try {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (isHiddenDirectory(name)) continue
      if (shouldSkipSkillScanEntry(root, name)) continue
      const fullPath = join(root, name)
      if (skillRootHasPackages(fullPath)) {
        results.push(fullPath)
      } else if (maxDepth > 1) {
        results.push(...await findSkillRootsUnder(fullPath, maxDepth - 1))
      }
    }
  } catch {
    // ignore permission or access errors
  }
  return results
}

async function discoverCodexPluginSkillRoots(): Promise<string[]> {
  const roots: string[] = []
  await collectSkillRoots(join(homedir(), '.codex', 'plugins', 'cache'), roots, 0, 5)
  return roots
}

async function collectSkillRoots(root: string, roots: string[], depth: number, maxDepth: number): Promise<void> {
  if (depth > maxDepth || !existsSync(root)) return
  if (basename(root) === 'skills' && skillRootHasPackages(root)) {
    roots.push(root)
    return
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => collectSkillRoots(join(root, entry.name), roots, depth + 1, maxDepth)))
}

function skillRootHasPackages(root: string): boolean {
  if (existsSync(join(root, 'SKILL.md')) || existsSync(join(root, 'skill.json'))) return true
  try {
    return readdirSync(root, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() &&
      (existsSync(join(root, entry.name, 'SKILL.md')) || existsSync(join(root, entry.name, 'skill.json')))
    )
  } catch {
    return false
  }
}

async function packageCandidates(root: string, maxDepth: number): Promise<string[]> {
  const candidates = new Set<string>()
  if (existsSync(join(root, 'skill.json')) || existsSync(join(root, 'SKILL.md'))) {
    candidates.add(root)
  }
  if (maxDepth <= 0) return [...candidates]
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipSkillPackageDirectory(entry.name)) continue
    const dir = join(root, entry.name)
    if (existsSync(join(dir, 'skill.json')) || existsSync(join(dir, 'SKILL.md'))) {
      candidates.add(dir)
      continue
    }
    for (const child of await packageCandidates(dir, maxDepth - 1)) {
      candidates.add(child)
    }
  }
  return [...candidates]
}

async function loadSkillSummary(root: string, scope: GuiSkillScope): Promise<GuiSkillSummary | null> {
  const manifestPath = join(root, 'skill.json')
  const hasManifest = existsSync(manifestPath)
  const entryPath = join(root, 'SKILL.md')
  const hasEntry = existsSync(entryPath)
  if (!hasManifest && !hasEntry) return null

  const manifest = hasManifest
    ? (JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>)
    : {}
  const manifestName = stringValue(manifest.name)
  const manifestDescription = stringValue(manifest.description)
  const manifestId = stringValue(manifest.id)
  const entry = stringValue(manifest.entry) || 'SKILL.md'
  const legacy = !hasManifest

  let frontmatter: { id?: string; name?: string; description?: string; taskId?: string } = {}
  if (hasEntry) {
    const content = await readFile(entryPath, 'utf8')
    frontmatter = readFrontmatter(content)
  }

  let name: string
  let description: string | undefined

  if (scope === 'builtin') {
    const frontmatterName = frontmatter.name?.trim()
    const frontmatterDescription = frontmatter.description?.trim()
    if (frontmatterName && isChineseText(frontmatterName)) {
      name = frontmatterName
    } else if (manifestDescription && isChineseText(manifestDescription)) {
      name = extractChineseTitle(manifestDescription, manifestName || titleFromSlug(basename(root)))
    } else {
      name = manifestName || frontmatterName || titleFromSlug(basename(root))
    }
    description = frontmatterDescription || (manifestDescription && isChineseText(manifestDescription) ? manifestDescription : undefined)
  } else {
    name = manifestName || displaySkillName(frontmatter.name, basename(root))
    description = manifestDescription || frontmatter.description || undefined
  }

  const id = slug(manifestId || frontmatter.id || frontmatter.taskId || (legacy ? basename(root) : name || basename(root)))

  return {
    id,
    name,
    ...(description ? { description } : {}),
    root,
    entryPath: join(root, entry),
    scope,
    legacy,
    ...(isUserInstalledSkillPath(root) ? { userInstalled: true } : {})
  }
}

async function importSkillCandidates(root: string): Promise<string[]> {
  if (isSkillPackageDirectory(root)) return [root]
  return packageCandidates(root, SKILL_PACKAGE_SCAN_DEPTH)
}

function isSkillPackageDirectory(root: string): boolean {
  return existsSync(join(root, 'SKILL.md')) || existsSync(join(root, 'skill.json'))
}

function isZipFile(path: string): boolean {
  return extname(path).toLowerCase() === '.zip'
}

async function installSkillDirectory(source: string, targetRoot: string): Promise<{ name: string; path: string; replaced: boolean }> {
  const name = validateSkillDirectoryName(basename(source))
  const target = join(targetRoot, name)
  let replaced = false

  if (existsSync(target)) {
    const [sourceReal, targetReal] = await Promise.all([
      realpath(source).catch(() => source),
      realpath(target).catch(() => target)
    ])
    if (comparablePath(sourceReal) === comparablePath(targetReal)) {
      return { name, path: target, replaced: false }
    }
    await rm(target, { recursive: true, force: true })
    replaced = true
  }

  await cp(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    filter: shouldImportPath
  })
  return { name, path: target, replaced }
}

function validateSkillDirectoryName(name: string): string {
  const value = name.trim()
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`无效的 Skill 文件夹名称：${name}`)
  }
  return value
}

function shouldImportPath(path: string): boolean {
  const name = basename(path)
  return name !== 'node_modules' && name !== '__pycache__' && name !== '.git'
}

async function extractSkillZip(zipPath: string): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), 'legalwork-skill-import-'))
  try {
    await ensureSafeZipEntries(zipPath)
    if (process.platform === 'win32') {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        zipPath,
        target
      ], { timeout: 120_000 })
    } else {
      await execFileAsync('unzip', ['-q', zipPath, '-d', target], { timeout: 120_000 })
    }
    return target
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
}

async function ensureSafeZipEntries(zipPath: string): Promise<void> {
  const output = process.platform === 'win32'
    ? await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '[Reflection.Assembly]::LoadWithPartialName("System.IO.Compression.FileSystem") | Out-Null; [IO.Compression.ZipFile]::OpenRead($args[0]).Entries | ForEach-Object { $_.FullName }',
        zipPath
      ], { encoding: 'utf8', timeout: 30_000 })
    : await execFileAsync('unzip', ['-Z1', zipPath], { encoding: 'utf8', timeout: 30_000 })
  for (const line of output.stdout.split(/\r?\n/)) {
    const entry = line.trim()
    if (!entry) continue
    const parts = entry.split(/[\\/]+/)
    if (isAbsolute(entry) || entry.includes('\0') || parts.includes('..')) {
      throw new Error('zip 中包含不安全路径。')
    }
  }
}

function shouldSkipSkillPackageDirectory(name: string): boolean {
  return name.startsWith('.') ||
    name === '__pycache__' ||
    name === 'node_modules' ||
    name === '.venv' ||
    name === 'venv' ||
    name === '_template'
}

function readFrontmatter(content: string): { id?: string; name?: string; description?: string; taskId?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return { description: firstMarkdownParagraph(content) }
  const yaml = match[1] ?? ''
  return {
    id: frontmatterString(yaml, 'id'),
    name: frontmatterString(yaml, 'name'),
    description: frontmatterString(yaml, 'description') || firstMarkdownParagraph(content.slice(match[0].length)),
    taskId: frontmatterString(yaml, 'task_id')
  }
}

function frontmatterString(yaml: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(yaml)
  return match ? stripQuotes(match[1] ?? '').trim() || undefined : undefined
}

function firstMarkdownParagraph(markdown: string): string | undefined {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.replace(/^#+\s*/, '').trim())
    .find(Boolean)
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isChineseText(text: string): boolean {
  return /[一-鿿]/.test(text)
}

function extractChineseTitle(description: string | undefined, fallback: string): string {
  if (!description) return fallback
  if (!isChineseText(description)) return fallback
  const colonIndex = description.indexOf('：')
  if (colonIndex > 0 && colonIndex < 30) {
    const title = description.slice(0, colonIndex).trim()
    if (isChineseText(title)) return title
  }
  return fallback
}

function titleFromSlug(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function displaySkillName(frontmatterName: string | undefined, folderName: string): string {
  const value = frontmatterName?.trim() ?? ''
  if (!value) return titleFromSlug(folderName)
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value) ? titleFromSlug(value) : value
}

function slug(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'skill'
}

function dedupeSkills(skills: GuiSkillSummary[]): GuiSkillSummary[] {
  const unique = new Map<string, GuiSkillSummary>()
  for (const skill of skills.sort(compareSkillSummary)) {
    if (!unique.has(skill.id)) unique.set(skill.id, skill)
  }
  return [...unique.values()]
}

function compareSkillSummary(a: GuiSkillSummary, b: GuiSkillSummary): number {
  if (a.scope !== b.scope) {
    const priority = { project: 0, global: 1, builtin: 2 }
    return priority[a.scope] - priority[b.scope]
  }
  return a.name.localeCompare(b.name)
}

function scopeForConfiguredRoot(path: string, workspaceRoots: string[]): GuiSkillScope {
  const comparable = comparablePath(path)
  return workspaceRoots.some((workspaceRoot) => {
    const workspace = comparablePath(workspaceRoot)
    return comparable === workspace || comparable.startsWith(`${workspace}/`)
  }) ? 'project' : 'global'
}

function uniqueSkillRoots(roots: GuiSkillRoot[]): GuiSkillRoot[] {
  const seen = new Set<string>()
  const out: GuiSkillRoot[] = []
  for (const root of roots) {
    const key = comparablePath(root.path)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function comparablePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()
}

function isUserInstalledSkillPath(path: string): boolean {
  const root = comparablePath(USER_INSTALLED_SKILL_ROOT)
  const value = comparablePath(resolve(path))
  const rel = relative(root, value)
  return value === root || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
