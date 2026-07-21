import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const tempRoots: string[] = []
const scriptPath = resolve('scripts/generate-mac-latest.cjs')

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'legalwork-mac-latest-'))
  tempRoots.push(root)
  return root
}

function writeArtifact(distDir: string, name: string): void {
  writeFileSync(join(distDir, name), `dummy ${name}\n`, 'utf8')
}

function runGenerateMacLatest(distDir: string): string {
  return execFileSync(process.execPath, [scriptPath, distDir], {
    cwd: resolve('.'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('generate-mac-latest', () => {
  it('writes macOS updater metadata with zip files for both architectures', () => {
    const distDir = tempRoot()
    for (const artifact of [
      'legalwork-0.2.9-mac-arm64.dmg',
      'legalwork-0.2.9-mac-arm64.zip',
      'legalwork-0.2.9-mac-x64.dmg',
      'legalwork-0.2.9-mac-x64.zip'
    ]) {
      writeArtifact(distDir, artifact)
    }

    expect(runGenerateMacLatest(distDir)).toContain('Generated')

    const latestMac = readFileSync(join(distDir, 'latest-mac.yml'), 'utf8')
    expect(latestMac).toContain('version: 0.2.9')
    expect(latestMac).toContain('url: legalwork-0.2.9-mac-arm64.zip')
    expect(latestMac).toContain('url: legalwork-0.2.9-mac-x64.zip')
    expect(latestMac).toContain('path: legalwork-0.2.9-mac-x64.zip')
  })

  it('fails when macOS zip artifacts are missing', () => {
    const distDir = tempRoot()
    mkdirSync(distDir, { recursive: true })
    writeArtifact(distDir, 'legalwork-0.2.9-mac-arm64.dmg')
    writeArtifact(distDir, 'legalwork-0.2.9-mac-x64.dmg')

    expect(() => runGenerateMacLatest(distDir)).toThrow(
      /macOS in-app updates require zip artifacts for both arm64 and x64/
    )
  })
})
