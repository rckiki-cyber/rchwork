#!/usr/bin/env node
'use strict'

/**
 * Prepare relocatable Office Python runtimes at RELEASE BUILD TIME.
 *
 * End-user machines must never create a venv or run pip for Word/Excel/PPT.
 * This script downloads python-build-standalone CPython 3.11 distributions,
 * installs the pinned legal_document_formatting requirements into them,
 * verifies the core imports, and stages them under:
 *   vendor/office-runtime/<platform>-<arch>
 */

const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const {
  cpSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')

const DESKTOP_ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..')
const REQUIREMENTS = join(REPO_ROOT, 'skills', 'legal_document_formatting', 'requirements.txt')
const VENDOR_ROOT = join(DESKTOP_ROOT, 'vendor', 'office-runtime')
const CACHE_ROOT = join(DESKTOP_ROOT, '.cache', 'office-runtime')
const PYTHON_LINE = '3.11'
const REQUIRED_IMPORTS = ['docx', 'openpyxl', 'pptx', 'lxml', 'PIL', 'reportlab']
const RELEASE_REPOS = ['astral-sh/python-build-standalone', 'indygreg/python-build-standalone']
const SUPPORTED_TARGETS = new Set(['mac-arm64', 'mac-x64', 'win-x64', 'win-ia32', 'linux-x64'])

function fail(message) {
  console.error(`[office-runtime] ${message}`)
  process.exit(1)
}

function info(message) {
  console.log(`[office-runtime] ${message}`)
}

function currentPlatformName() {
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'linux') return 'linux'
  fail(`Unsupported build host platform: ${process.platform}`)
}

function configuredTargetsForPlatform(platform) {
  if (platform === 'mac') return ['mac-x64', 'mac-arm64']
  if (platform === 'win') return ['win-x64', 'win-ia32']
  if (platform === 'linux') return ['linux-x64']
  fail(`Unsupported Office runtime platform: ${platform}`)
}

function parseArgs(argv) {
  const args = { platform: '', arch: '', force: false, allCurrent: false }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--platform') args.platform = String(argv[++i] || '')
    else if (value === '--arch') args.arch = String(argv[++i] || '')
    else if (value === '--all-current') args.allCurrent = true
    else if (value === '--force') args.force = true
    else if (value === '--help' || value === '-h') {
      console.log([
        'Usage:',
        '  node prepare-office-runtime.cjs --platform mac|win|linux --arch arm64|x64|ia32 [--force]',
        '  node prepare-office-runtime.cjs --all-current [--force]'
      ].join('\n'))
      process.exit(0)
    } else fail(`Unknown argument: ${value}`)
  }
  if (args.allCurrent) {
    if (args.platform || args.arch) fail('--all-current cannot be combined with --platform/--arch')
    const platform = currentPlatformName()
    return { ...args, targets: configuredTargetsForPlatform(platform) }
  }
  if (!args.platform || !args.arch) fail('--platform and --arch are required (or use --all-current)')
  const target = `${args.platform}-${args.arch}`
  if (!SUPPORTED_TARGETS.has(target)) fail(`Unsupported Office runtime target: ${target}`)
  return { ...args, targets: [target] }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function platformFromTarget(target) {
  return target.split('-')[0]
}

function pythonRelativePath(platform) {
  return platform === 'win' ? join('python', 'python.exe') : join('python', 'bin', 'python3')
}

function sitePackagesPath(runtimeRoot, platform) {
  const direct = platform === 'win'
    ? join(runtimeRoot, 'python', 'Lib', 'site-packages')
    : join(runtimeRoot, 'python', 'lib', `python${PYTHON_LINE}`, 'site-packages')
  if (existsSync(direct)) return direct
  const libRoot = join(runtimeRoot, 'python', platform === 'win' ? 'Lib' : 'lib')
  if (!existsSync(libRoot)) fail(`Cannot locate Python library directory in ${runtimeRoot}`)
  const stack = [libRoot]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory() && entry.name === 'site-packages') return path
      if (entry.isDirectory()) stack.push(path)
    }
  }
  fail(`Cannot locate site-packages in ${runtimeRoot}`)
}

function moduleFilesPresent(runtimeRoot, platform) {
  const site = sitePackagesPath(runtimeRoot, platform)
  return REQUIRED_IMPORTS.every((name) => existsSync(join(site, name)))
}

function runtimeAlreadyValid(runtimeRoot, target, requirementsSha) {
  const platform = platformFromTarget(target)
  if (!existsSync(join(runtimeRoot, 'runtime.json'))) return false
  if (!existsSync(join(runtimeRoot, pythonRelativePath(platform)))) return false
  try {
    const marker = JSON.parse(readFileSync(join(runtimeRoot, 'runtime.json'), 'utf8'))
    return marker.target === target &&
      marker.requirementsSha256 === requirementsSha &&
      marker.pythonLine === PYTHON_LINE &&
      moduleFilesPresent(runtimeRoot, platform)
  } catch {
    return false
  }
}

function assetMatcher(target) {
  const triples = {
    'mac-arm64': 'aarch64-apple-darwin',
    'mac-x64': 'x86_64-apple-darwin',
    'win-x64': 'x86_64-pc-windows-msvc',
    'win-ia32': 'i686-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-gnu'
  }
  const triple = triples[target]
  return (name) => name.startsWith(`cpython-${PYTHON_LINE}.`) &&
    name.includes(triple) &&
    name.includes('install_only') &&
    name.endsWith('.tar.gz')
}

async function githubJson(url) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'legalwork-office-runtime-builder'
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

async function resolveStandaloneAsset(target) {
  const override = (process.env.LEGALWORK_OFFICE_PYTHON_STANDALONE_URL || '').trim()
  if (override) {
    return {
      url: override,
      name: basename(new URL(override).pathname),
      release: 'override',
      repository: 'override'
    }
  }
  const matcher = assetMatcher(target)
  let lastError = null
  for (const repository of RELEASE_REPOS) {
    try {
      const release = await githubJson(`https://api.github.com/repos/${repository}/releases/latest`)
      const candidates = Array.isArray(release.assets)
        ? release.assets.filter((asset) => asset && typeof asset.name === 'string' && matcher(asset.name))
        : []
      if (candidates.length === 0) {
        throw new Error(`latest release ${release.tag_name || ''} has no matching CPython ${PYTHON_LINE} asset for ${target}`)
      }
      candidates.sort((a, b) => Number(b.name.includes('-shared-')) - Number(a.name.includes('-shared-')) || a.name.localeCompare(b.name))
      const asset = candidates[0]
      return {
        url: asset.browser_download_url,
        name: asset.name,
        release: release.tag_name || 'latest',
        repository
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('Unable to resolve python-build-standalone release asset')
}

async function download(url, destination) {
  if (existsSync(destination) && statSync(destination).size > 1024 * 1024) {
    info(`Using cached ${basename(destination)}`)
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  const headers = { 'user-agent': 'legalwork-office-runtime-builder' }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  info(`Downloading ${url}`)
  const response = await fetch(url, { headers, redirect: 'follow' })
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(destination, bytes)
}

function extractArchive(archive, destination) {
  mkdirSync(destination, { recursive: true })
  execFileSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit', windowsHide: true })
}

function canRun(executable, args = ['--version']) {
  try {
    execFileSync(executable, args, { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

function builderPython() {
  const candidates = [
    process.env.PYTHON,
    process.env.PYTHON3,
    process.platform === 'win32' ? 'python' : 'python3',
    'python'
  ]
  for (const candidate of candidates) {
    if (candidate && canRun(candidate)) return candidate
  }
  return null
}

function pipPlatform(target) {
  return {
    'mac-arm64': 'macosx_11_0_arm64',
    'mac-x64': 'macosx_11_0_x86_64',
    'win-x64': 'win_amd64',
    'win-ia32': 'win32',
    'linux-x64': 'manylinux_2_17_x86_64'
  }[target]
}

/**
 * python-build-standalone ships bin/{python3,python,idle3,2to3,...} as absolute
 * symlinks pointing at the build-time path. cpSync(dereference) does not resolve
 * them here, so after the temp dir is removed the vendored python is unusable.
 * Rebuild those links as relative links to the real `*-3.11` binaries in the
 * same bin dir.
 */
function repairBundledSymlinks(runtimeRoot) {
  const binDir = join(runtimeRoot, 'python', 'bin')
  if (!existsSync(binDir)) return
  let repaired = 0
  for (const name of readdirSync(binDir)) {
    const linkPath = join(binDir, name)
    let stat
    try {
      stat = lstatSync(linkPath)
    } catch {
      continue
    }
    if (!stat.isSymbolicLink()) continue
    // Derive the versioned target (python3 -> python3.11, 2to3 -> 2to3-3.11,
    // idle3 -> idle3.11, python3-config -> python3.11-config). Derive from
    // PYTHON_LINE so a future Python bump cannot silently break these links.
    let target = null
    if (name === '2to3' || name === 'idle3' || name === 'pydoc3') {
      target = `${name}-${PYTHON_LINE}`
    } else if (name === 'python3-config') {
      target = `python${PYTHON_LINE}-config`
    } else if (name === 'python3' || name === 'python') {
      target = `python${PYTHON_LINE}`
    }
    if (!target || !existsSync(join(binDir, target))) continue
    try {
      const current = readlinkSync(linkPath)
      if (current === target) continue
      unlinkSync(linkPath)
      symlinkSync(target, linkPath)
      repaired += 1
    } catch {
      // Leave the link as-is if rebuilding fails.
    }
  }
  if (repaired > 0) info(`Repaired ${repaired} office-runtime python symlinks in ${binDir}`)
}

function targetPythonEnv(runtimeRoot) {
  // python-build-standalone macOS builds hard-code sys.prefix at build time and
  // are NOT relocatable by default: when the tree is moved from the extract temp
  // dir to vendor/office-runtime/<target>, the python still looks for its
  // stdlib/site-packages under the old temp path. Pointing PYTHONHOME at the
  // vendored python dir re-anchors sys.prefix so pip installs into the right
  // site-packages and `import docx` resolves from the packaged location.
  return { ...process.env, PYTHONHOME: join(runtimeRoot, 'python') }
}

function installRequirements(runtimeRoot, platform, target) {
  const targetPython = join(runtimeRoot, pythonRelativePath(platform))
  const commonArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', REQUIREMENTS]
  if (canRun(targetPython)) {
    try {
      info(`Installing Office packages with target Python (${target})`)
      execFileSync(targetPython, commonArgs, { stdio: 'inherit', windowsHide: true, env: targetPythonEnv(runtimeRoot) })
      return
    } catch (error) {
      info(`Target Python pip failed (${error.message}); trying cross-platform wheel installation.`)
    }
  }

  const hostPython = builderPython()
  if (!hostPython) fail(`Cannot execute target Python and no builder Python is available for cross-wheel install (${target})`)
  const site = sitePackagesPath(runtimeRoot, platform)
  mkdirSync(site, { recursive: true })
  info(`Installing binary wheels into ${target} runtime using builder Python`)
  execFileSync(hostPython, [
    '-m', 'pip', 'install',
    '--disable-pip-version-check', '--no-input',
    '--only-binary=:all:',
    '--platform', pipPlatform(target),
    '--python-version', '311',
    '--implementation', 'cp',
    '--abi', 'cp311',
    '--target', site,
    '-r', REQUIREMENTS
  ], { stdio: 'inherit', windowsHide: true })
}

function verifyRuntime(runtimeRoot, platform, target) {
  const python = join(runtimeRoot, pythonRelativePath(platform))
  if (!existsSync(python)) fail(`Bundled Python executable missing after preparation: ${python}`)
  if (!moduleFilesPresent(runtimeRoot, platform)) fail(`One or more Office Python packages are missing from ${target}`)
  if (canRun(python)) {
    const script = REQUIRED_IMPORTS.map((name) => `import ${name}`).join(';')
    execFileSync(python, ['-c', script], { stdio: 'inherit', windowsHide: true, env: targetPythonEnv(runtimeRoot) })
  } else {
    info(`Target Python cannot execute on this builder; validated packaged module files for ${target}.`)
  }
}

async function prepareTarget(target, force, requirementsSha) {
  const platform = platformFromTarget(target)
  const runtimeRoot = join(VENDOR_ROOT, target)
  if (!force && runtimeAlreadyValid(runtimeRoot, target, requirementsSha)) {
    info(`${target} Office runtime is already prepared.`)
    return
  }

  const asset = await resolveStandaloneAsset(target)
  mkdirSync(CACHE_ROOT, { recursive: true })
  const archive = join(CACHE_ROOT, asset.name)
  await download(asset.url, archive)

  const temp = mkdtempSync(join(tmpdir(), `legalwork-office-runtime-${target}-`))
  try {
    extractArchive(archive, temp)
    const extractedPython = join(temp, 'python')
    if (!existsSync(extractedPython)) fail(`Archive ${asset.name} did not contain python/`)
    rmSync(runtimeRoot, { recursive: true, force: true })
    mkdirSync(runtimeRoot, { recursive: true })
    cpSync(extractedPython, join(runtimeRoot, 'python'), { recursive: true, force: true })
    // bin/python3 等是指向临时目录的绝对符号链接，cpSync 不解引用，需手动重建为相对链接。
    repairBundledSymlinks(runtimeRoot)
    installRequirements(runtimeRoot, platform, target)
    verifyRuntime(runtimeRoot, platform, target)
    writeFileSync(join(runtimeRoot, 'runtime.json'), `${JSON.stringify({
      target,
      pythonLine: PYTHON_LINE,
      requirementsSha256: requirementsSha,
      sourceRepository: asset.repository,
      sourceRelease: asset.release,
      sourceAsset: asset.name,
      preparedAt: new Date().toISOString(),
      imports: REQUIRED_IMPORTS
    }, null, 2)}\n`, 'utf8')
    info(`Prepared ${target} Office runtime at ${runtimeRoot}`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

async function main() {
  if (!existsSync(REQUIREMENTS)) fail(`Missing Office requirements: ${REQUIREMENTS}`)
  const args = parseArgs(process.argv.slice(2))
  const requirementsSha = sha256File(REQUIREMENTS)
  for (const target of args.targets) {
    await prepareTarget(target, args.force, requirementsSha)
  }
}

main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)))
