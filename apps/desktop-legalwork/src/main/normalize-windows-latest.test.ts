import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const tempRoots: string[] = []
const scriptPath = resolve('scripts/normalize-windows-latest.cjs')

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'legalwork-win-latest-'))
  tempRoots.push(root)
  return root
}

function writeFile(path: string, content = 'dummy\n'): void {
  writeFileSync(path, content, 'utf8')
}

function runNormalizeWindowsLatest(distDir: string): string {
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

describe('normalize-windows-latest', () => {
  it('removes obsolete Windows updater files and keeps the supported x64 installer', () => {
    const distDir = tempRoot()
    writeFile(join(distDir, 'legalwork-0.2.9-win-x64.exe'))
    writeFile(join(distDir, 'legalwork-0.2.9-win-ia32.exe'))
    writeFile(
      join(distDir, 'latest.yml'),
      [
        'version: 0.2.9',
        'files:',
        '  - url: legalwork-0.2.9-win-ia32.exe',
        '    sha512: ia32sha',
        '    size: 100',
        '  - url: legalwork-0.2.9-win-x64.exe',
        '    sha512: x64sha',
        '    size: 200',
        '  - url: legalwork-0.2.9-win.exe',
        '    sha512: missingsha',
        '    size: 300',
        'path: legalwork-0.2.9-win-ia32.exe',
        'sha512: ia32sha',
        "releaseDate: '2026-07-14T14:03:25.988Z'",
        ''
      ].join('\n')
    )

    expect(runNormalizeWindowsLatest(distDir)).toContain('Normalized')

    const latest = readFileSync(join(distDir, 'latest.yml'), 'utf8')
    expect(latest).toContain('url: legalwork-0.2.9-win-x64.exe')
    expect(latest).not.toContain('url: legalwork-0.2.9-win-ia32.exe')
    expect(latest).toContain('path: legalwork-0.2.9-win-x64.exe')
    expect(latest).not.toContain('legalwork-0.2.9-win.exe')
  })

  it('fails when the Windows x64 installer is missing', () => {
    const distDir = tempRoot()
    mkdirSync(distDir, { recursive: true })
    writeFile(join(distDir, 'legalwork-0.2.9-win-ia32.exe'))
    writeFile(
      join(distDir, 'latest.yml'),
      [
        'version: 0.2.9',
        'files:',
        '  - url: legalwork-0.2.9-win-ia32.exe',
        '    sha512: ia32sha',
        '    size: 100',
        'path: legalwork-0.2.9-win-ia32.exe',
        'sha512: ia32sha',
        ''
      ].join('\n')
    )

    expect(() => runNormalizeWindowsLatest(distDir)).toThrow(
      /Windows in-app updates require an x64 installer/
    )
  })
})
