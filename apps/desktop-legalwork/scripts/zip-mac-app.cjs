#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

const arch = process.argv[2]
if (arch !== 'arm64' && arch !== 'x64') {
  console.error('Usage: node scripts/zip-mac-app.cjs <arm64|x64>')
  process.exit(1)
}

const root = resolve(__dirname, '..')
const pkg = require(join(root, 'package.json'))
const version = (process.env.LEGALWORK_APP_VERSION || process.env.LEGALWORK_APP_VERSION || pkg.version || '').trim()
if (!version) {
  console.error('[zip-mac-app] Could not resolve package version.')
  process.exit(1)
}

const distDir = resolve(process.env.LEGALWORK_DIST_DIR || process.env.LEGALWORK_DIST_DIR || join(root, 'dist'))
const appOutDir = join(distDir, arch === 'arm64' ? 'mac-arm64' : 'mac')
const appName = readdirSync(appOutDir).find((entry) => entry.endsWith('.app') && statSync(join(appOutDir, entry)).isDirectory())
if (!appName) {
  console.error(`[zip-mac-app] No .app bundle found in ${appOutDir}`)
  process.exit(1)
}
const appPath = join(appOutDir, appName)
const zipPath = join(distDir, `legalwork-${version}-mac-${arch}.zip`)

rmSync(zipPath, { force: true })
console.log(`[zip-mac-app] Creating ${zipPath}`)
execFileSync(
  'ditto',
  ['-c', '-k', '--sequesterRsrc', '--keepParent', appName, zipPath],
  {
    cwd: appOutDir,
    stdio: 'inherit'
  }
)
