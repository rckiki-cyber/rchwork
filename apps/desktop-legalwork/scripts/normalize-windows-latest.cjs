#!/usr/bin/env node

const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { basename, join, resolve } = require('node:path')
const yaml = require('js-yaml')

function usage() {
  console.error('Usage: node scripts/normalize-windows-latest.cjs [distDir]')
}

function quote(value) {
  return String(value ?? '').trim().replace(/^['"]|['"]$/g, '')
}

function updateFileName(file) {
  return basename(quote(file?.url ?? ''))
}

function windowsArch(fileName) {
  if (/-win-x64\.exe$/i.test(fileName)) return 'x64'
  if (/-win-ia32\.exe$/i.test(fileName)) return 'ia32'
  return null
}

function emitLatestYml(info, files, primary) {
  return [
    `version: ${quote(info.version)}`,
    'files:',
    ...files.flatMap((file) => {
      const lines = [
        `  - url: ${quote(file.url)}`,
        `    sha512: ${quote(file.sha512)}`,
        `    size: ${Number.parseInt(String(file.size ?? 0), 10) || 0}`
      ]
      if (file.blockMapSize) {
        lines.push(`    blockMapSize: ${Number.parseInt(String(file.blockMapSize), 10) || 0}`)
      }
      return lines
    }),
    `path: ${quote(primary.url)}`,
    `sha512: ${quote(primary.sha512)}`,
    `releaseDate: '${quote(info.releaseDate) || new Date().toISOString()}'`,
    ''
  ].join('\n')
}

function main() {
  const distDir = resolve(process.argv[2] || 'dist')
  const latestPath = join(distDir, 'latest.yml')
  if (!existsSync(latestPath)) {
    throw new Error(`Missing ${latestPath}`)
  }

  const info = yaml.load(readFileSync(latestPath, 'utf8'))
  if (!info || typeof info !== 'object') {
    throw new Error('latest.yml is not valid YAML.')
  }
  if (!quote(info.version)) {
    throw new Error('latest.yml is missing version.')
  }
  if (!Array.isArray(info.files) || info.files.length === 0) {
    throw new Error('latest.yml is missing files.')
  }

  const existingExeFiles = info.files.filter((file) => {
    const fileName = updateFileName(file)
    return fileName.endsWith('.exe') && existsSync(join(distDir, fileName))
  })
  const filesByArch = new Map()
  for (const file of existingExeFiles) {
    const arch = windowsArch(updateFileName(file))
    if (arch) filesByArch.set(arch, file)
  }

  const missing = ['x64'].filter((arch) => !filesByArch.has(arch))
  if (missing.length > 0) {
    throw new Error(`Windows in-app updates require an x64 installer; missing: ${missing.join(', ')}`)
  }

  const files = ['x64'].map((arch) => filesByArch.get(arch))
  const primary = filesByArch.get('x64')
  writeFileSync(latestPath, emitLatestYml(info, files, primary), 'utf8')
  console.log(`Normalized ${latestPath}`)
}

try {
  main()
} catch (error) {
  usage()
  console.error(`[normalize-windows-latest] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
