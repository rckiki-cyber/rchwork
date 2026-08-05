const { execFileSync } = require('node:child_process')
const { chmodSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const LEGALWORK_RUNTIME_REQUIRED_PATHS = [
  'legalwork/dist/cli/serve-entry.js',
  'legalwork/package.json',
  'legalwork/package-lock.json',
  'legalwork/node_modules/zod/package.json',
  'legalwork/node_modules/diff/package.json',
  'legalwork/node_modules/@modelcontextprotocol/sdk/package.json',
  'legalwork/node_modules/@officecli/officecli/package.json'
]

const DATA_COMPLIANCE_REQUIRED_PATHS = [
  'vendor/data-compliance-review-codex/data-compliance-web/app.py',
  'vendor/data-compliance-review-codex/data-compliance-web/server_entry.py',
  'vendor/data-compliance-review-codex/data-compliance-web/desensitize_engine.py',
  'vendor/data-compliance-review-codex/data-compliance-web/requirements.txt',
  'vendor/data-compliance-review-codex/data-compliance-web/templates/index.html',
  'vendor/data-compliance-review-codex/data-compliance-web/templates/result.html',
  'vendor/data-compliance-review-codex/data-compliance-web/config/review-paths.json'
]

const DATA_COMPLIANCE_OPTIONAL_PATHS = [
  'vendor/data-compliance-review-codex/projects/data-compliance-ai-project-kit/knowledge-base/local-regulations.sqlite3'
]

const DOCUMENT_OCR_REQUIRED_PATHS = [
  'ocr_agent.py',
  'document/__init__.py',
  'document/intake/router.py',
  'document/ocr/router.py'
]

const IMA_MCP_SCRIPT_RELATIVE_PATH = 'scripts/ima-mcp-server.py'

// legalwork 不使用相机 / 麦克风 / 蓝牙 / 相册。Electron 框架默认在 Info.plist 里塞了这些
// 权限用途串，会导致 macOS 在相关 API 被触达时弹出无谓的权限请求（如相册访问）。
// 打包后、签名前删掉这些键，即可从根本上避免这些与功能无关的权限弹窗。
const MAC_UNUSED_PERMISSION_KEYS = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSPhotoLibraryUsageDescription',
  'NSPhotoLibraryAddUsageDescription'
]

function normalizePlatform(platform) {
  return platform === 'win' ? 'win32' : platform
}

function appBundlePath(context) {
  return join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
}

function packedResourcesDir(context) {
  if (normalizePlatform(context.electronPlatformName) === 'darwin') {
    return join(appBundlePath(context), 'Contents', 'Resources')
  }
  return join(context.appOutDir, 'resources')
}

function unpackedAppRoot(context) {
  return join(packedResourcesDir(context), 'app.asar.unpacked')
}

function assertExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`[after-pack] Missing ${label}: ${path}`)
  }
}

function npmCommand(args, platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm', ...args]
    }
  }
  return { command: 'npm', args }
}

function prunePackedLegalworkDependencies(context) {
  const root = unpackedAppRoot(context)
  const legalworkDir = join(root, 'legalwork')
  if (!existsSync(legalworkDir)) return

  assertExists(join(legalworkDir, 'package.json'), 'Legalwork package manifest')
  assertExists(join(legalworkDir, 'node_modules'), 'Legalwork node_modules')

  const prune = npmCommand(['prune', '--omit=dev', '--ignore-scripts'])
  execFileSync(prune.command, prune.args, {
    cwd: legalworkDir,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false'
    },
    stdio: 'inherit'
  })

  // Keep native SQLite on the app root dependency so electron-builder's
  // native-module rebuild owns the target arch and Electron ABI.
  assertExists(
    join(root, 'node_modules', 'better-sqlite3', 'package.json'),
    'root better-sqlite3 dependency'
  )
  rmSync(join(legalworkDir, 'node_modules', 'better-sqlite3'), { recursive: true, force: true })
}

function projectDir(context) {
  return context.packager?.projectDir || join(__dirname, '..')
}

function restoreBundledOfficeCli(context) {
  const source = join(projectDir(context), 'legalwork', 'node_modules', '@officecli', 'officecli')
  const target = join(
    unpackedAppRoot(context),
    'legalwork',
    'node_modules',
    '@officecli',
    'officecli'
  )
  const targetBinary = join(target, 'vendor', 'officecli')
  if (!existsSync(source)) {
    console.warn(`[after-pack] OfficeCLI package not found at ${source}; skipping bundled restore.`)
    return
  }
  cpSync(source, target, { recursive: true, force: true })
  if (existsSync(targetBinary)) {
    chmodSync(targetBinary, 0o755)
    // 打包机的 host 二进制只适用于构建机自身架构。目标平台与构建机平台不一致时
    // （例如在 macOS 开发机上打 Windows 包，host 二进制是 Mach-O），这个二进制在
    // 目标平台不可执行：保留它会让 resolveOfficeCliBinaryPath 误判"二进制存在"而走
    // direct 路径（Windows 上 CreateProcess 直接失败）。删除它，回落到 officecli.js
    // shim，由 shim 在目标平台首次运行时下载正确的原生二进制。
    // 仅当"构建机是 darwin 且目标非 darwin"才删：在 Windows/Linux 打包机上，host
    // 二进制本就可用于同平台目标，删除反而迫使走需联网下载的 shim 通道。
    const hostPlatform = process.platform
    const targetPlatform = normalizePlatform(context.electronPlatformName)
    if (hostPlatform === 'darwin' && targetPlatform !== 'darwin') {
      rmSync(targetBinary, { force: true })
      console.warn(
        '[after-pack] Removed macOS host-arch OfficeCLI binary for non-darwin target; launcher shim will download the correct binary on first run.'
      )
    }
  }
  patchOfficeCliShimWindowsHide(target)
}

/**
 * Patch the bundled officecli.js launcher shim so its child-process spawn never
 * pops a console window on Windows. The shim runs `spawnSync(bin, argv, { stdio:
 * 'inherit' })` to exec the native binary; on Windows, launching a console app
 * this way without `windowsHide` shows a command-prompt window (titled
 * "Default: <path>"). MCP starts officecli through this shim whenever the native
 * binary is absent / not-yet-downloaded, so this is the reliable place to hide it.
 */
function patchOfficeCliShimWindowsHide(targetDir) {
  const shimPath = join(targetDir, 'officecli.js')
  if (!existsSync(shimPath)) {
    console.warn(`[after-pack] officecli.js shim not found at ${shimPath}; cannot apply windowsHide patch.`)
    return
  }
  const original = readFileSync(shimPath, 'utf8')
  // 用宽松正则匹配（容忍空格/引号差异），避免 officecli 升级改格式后补丁静默失效。
  const patched = original.replace(
    /(\{[\s'"]*stdio[\s'"]*:[\s'"]*inherit[\s'"]*)(\})/,
    "$1, windowsHide: true }"
  )
  if (patched === original) {
    console.warn(
      '[after-pack] FAILED to patch officecli.js shim: did not find the `{ stdio: "inherit" }` spawn options. Windows console popup may still occur.'
    )
    return
  }
  writeFileSync(shimPath, patched, 'utf8')
  console.warn('[after-pack] Patched officecli.js shim: spawnSync now uses windowsHide (no console popup on Windows).')
}

function validateBundledLegalworkRuntime(context) {
  const root = unpackedAppRoot(context)
  for (const relativePath of LEGALWORK_RUNTIME_REQUIRED_PATHS) {
    assertExists(join(root, relativePath), relativePath)
  }
  assertExists(
    join(root, 'node_modules', 'better-sqlite3', 'package.json'),
    'root better-sqlite3 dependency'
  )
}

function validateBundledDataComplianceRuntime(context) {
  const root = unpackedAppRoot(context)
  for (const relativePath of DATA_COMPLIANCE_REQUIRED_PATHS) {
    assertExists(join(root, relativePath), relativePath)
  }
  for (const relativePath of DATA_COMPLIANCE_OPTIONAL_PATHS) {
    const absolutePath = join(root, relativePath)
    if (!existsSync(absolutePath)) {
      console.warn(`[after-pack] Optional data compliance resource missing: ${relativePath}`)
    }
  }
}

function validateBundledDocumentOcrRuntime(context) {
  const root = packedResourcesDir(context)
  for (const relativePath of DOCUMENT_OCR_REQUIRED_PATHS) {
    assertExists(join(root, relativePath), relativePath)
  }
  assertExists(join(root, 'ocr-runtime'), 'ocr-runtime')
}

function validateBundledImaMcpServer(context) {
  const relativePath = IMA_MCP_SCRIPT_RELATIVE_PATH
  const sourcePath = join(projectDir(context), relativePath)
  const bundledPath = join(packedResourcesDir(context), relativePath)
  assertExists(sourcePath, 'IMA MCP source script')
  assertExists(bundledPath, 'bundled IMA MCP script')
  if (!readFileSync(sourcePath).equals(readFileSync(bundledPath))) {
    throw new Error(
      `[after-pack] Bundled IMA MCP script is stale and does not match the release source: ${bundledPath}`
    )
  }
}

function maybeAdhocSignMacApp(context) {
  if (normalizePlatform(context.electronPlatformName) !== 'darwin') {
    return
  }

  if (
    process.env.CSC_LINK ||
    process.env.CSC_NAME ||
    process.env.CSC_KEY_PASSWORD ||
    process.env.MAC_SIGN === '1'
  ) {
    console.log('[after-pack] Developer ID signing is enabled, skipping ad-hoc signing.')
    return
  }

  const appBundle = appBundlePath(context)
  if (!existsSync(appBundle)) {
    throw new Error(`[after-pack] App bundle not found for ad-hoc signing: ${appBundle}`)
  }

  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appBundle],
    { stdio: 'inherit' }
  )
}

function findInfoPlists(root) {
  if (!existsSync(root)) return []
  const results = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
      } else if (entry.isFile() && entry.name === 'Info.plist') {
        results.push(path)
      }
    }
  }
  return results.sort()
}

function macInfoPlistPaths(context) {
  const appBundle = appBundlePath(context)
  if (!existsSync(appBundle)) return []
  try {
    if (!statSync(appBundle).isDirectory()) return []
  } catch {
    return []
  }
  return findInfoPlists(appBundle)
}

function stripUnnecessaryMacPermissions(context) {
  if (normalizePlatform(context.electronPlatformName) !== 'darwin') {
    return
  }
  const infoPlists = macInfoPlistPaths(context)
  if (infoPlists.length === 0) {
    console.warn(`[after-pack] Info.plist not found, skip permission cleanup: ${appBundlePath(context)}`)
    return
  }
  for (const infoPlist of infoPlists) {
    for (const key of MAC_UNUSED_PERMISSION_KEYS) {
      try {
        execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, infoPlist], {
          stdio: 'ignore'
        })
        console.log(`[after-pack] Removed unused Info.plist permission key: ${key} from ${infoPlist}`)
      } catch {
        // Key absent — nothing to remove.
      }
    }
  }
}

async function afterPack(context) {
  prunePackedLegalworkDependencies(context)
  restoreBundledOfficeCli(context)
  validateBundledLegalworkRuntime(context)
  validateBundledDataComplianceRuntime(context)
  validateBundledDocumentOcrRuntime(context)
  validateBundledImaMcpServer(context)
  stripUnnecessaryMacPermissions(context)
  maybeAdhocSignMacApp(context)
}

exports.LEGALWORK_RUNTIME_REQUIRED_PATHS = LEGALWORK_RUNTIME_REQUIRED_PATHS
exports.DATA_COMPLIANCE_REQUIRED_PATHS = DATA_COMPLIANCE_REQUIRED_PATHS
exports.DATA_COMPLIANCE_OPTIONAL_PATHS = DATA_COMPLIANCE_OPTIONAL_PATHS
exports.DOCUMENT_OCR_REQUIRED_PATHS = DOCUMENT_OCR_REQUIRED_PATHS
exports.IMA_MCP_SCRIPT_RELATIVE_PATH = IMA_MCP_SCRIPT_RELATIVE_PATH
exports._internals = {
  appBundlePath,
  packedResourcesDir,
  unpackedAppRoot,
  npmCommand,
  findInfoPlists,
  macInfoPlistPaths,
  prunePackedLegalworkDependencies,
  restoreBundledOfficeCli,
  validateBundledLegalworkRuntime,
  validateBundledDataComplianceRuntime,
  validateBundledDocumentOcrRuntime,
  validateBundledImaMcpServer,
  stripUnnecessaryMacPermissions
}
exports.default = afterPack
