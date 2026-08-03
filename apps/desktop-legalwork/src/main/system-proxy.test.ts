import { describe, expect, it, vi, beforeEach } from 'vitest'

const execFileSync = vi.fn()

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args)
}))

async function load() {
  return await import('./system-proxy')
}

describe('detectMacSystemProxy', () => {
  beforeEach(() => {
    vi.resetModules()
    execFileSync.mockReset()
  })

  it('parses enabled HTTP and HTTPS proxy from scutil output', async () => {
    const { detectMacSystemProxy } = await load()
    execFileSync.mockReturnValue([
      '<dictionary> {',
      '  HTTPEnable : 1',
      '  HTTPPort : 1082',
      '  HTTPProxy : 127.0.0.1',
      '  HTTPSEnable : 1',
      '  HTTPSPort : 1082',
      '  HTTPSProxy : 127.0.0.1',
      '}'
    ].join('\n'))
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    const proxy = detectMacSystemProxy()
    expect(proxy).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:1082',
      HTTPS_PROXY: 'http://127.0.0.1:1082',
      NO_PROXY: expect.stringContaining('localhost')
    })
  })

  it('returns null when no proxy is enabled', async () => {
    const { detectMacSystemProxy } = await load()
    execFileSync.mockReturnValue('<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(detectMacSystemProxy()).toBeNull()
  })

  it('returns null when scutil fails', async () => {
    const { detectMacSystemProxy } = await load()
    execFileSync.mockImplementation(() => {
      throw new Error('command not found')
    })
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(detectMacSystemProxy()).toBeNull()
  })

  it('returns null on non-darwin platforms', async () => {
    const { detectMacSystemProxy } = await load()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(detectMacSystemProxy()).toBeNull()
  })
})

describe('detectWindowsSystemProxy', () => {
  beforeEach(() => {
    vi.resetModules()
    execFileSync.mockReset()
  })

  it('parses enabled proxy from registry output', async () => {
    const { detectWindowsSystemProxy } = await load()
    execFileSync.mockReturnValue([
      'ProxyEnable    REG_DWORD    0x1',
      'ProxyServer    REG_SZ    127.0.0.1:7890',
      'ProxyOverride  REG_SZ    localhost;<local>'
    ].join('\n'))
    Object.defineProperty(process, 'platform', { value: 'win32' })

    expect(detectWindowsSystemProxy()).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost;<local>'
    })
  })

  it('returns null when proxy is disabled', async () => {
    const { detectWindowsSystemProxy } = await load()
    execFileSync.mockReturnValue('ProxyEnable    REG_DWORD    0x0')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(detectWindowsSystemProxy()).toBeNull()
  })

  it('returns null when registry query fails', async () => {
    const { detectWindowsSystemProxy } = await load()
    execFileSync.mockImplementation(() => {
      throw new Error('registry error')
    })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(detectWindowsSystemProxy()).toBeNull()
  })
})

describe('detectSystemProxy', () => {
  beforeEach(() => {
    vi.resetModules()
    execFileSync.mockReset()
  })

  it('delegates to the mac detector on darwin', async () => {
    const { detectSystemProxy } = await load()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    execFileSync.mockReturnValue('HTTPEnable : 1\nHTTPPort : 1082\nHTTPProxy : 127.0.0.1')
    expect(detectSystemProxy()?.HTTPS_PROXY ?? detectSystemProxy()?.HTTP_PROXY).toBe('http://127.0.0.1:1082')
  })

  it('delegates to the windows detector on win32', async () => {
    const { detectSystemProxy } = await load()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileSync.mockReturnValue('ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    127.0.0.1:7890')
    expect(detectSystemProxy()).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: expect.any(String)
    })
  })

  it('returns null on linux', async () => {
    const { detectSystemProxy } = await load()
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(detectSystemProxy()).toBeNull()
  })
})
