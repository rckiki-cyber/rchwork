import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureErrorReporting,
  reportError,
  __resetForTest
} from './error-report'

describe('error-report', () => {
  let dataDir: string
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    __resetForTest()
    dataDir = mkdtempSync(join(tmpdir(), 'error-report-test-'))
    fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
  })

  afterEach(() => {
    __resetForTest()
    rmSync(dataDir, { recursive: true, force: true })
  })

  function baseConfig(overrides: Record<string, unknown> = {}) {
    return {
      dataDir,
      version: '0.3.10',
      platform: 'darwin' as const,
      arch: 'arm64',
      appId: 'legalwork',
      fetchImpl: fetchMock as unknown as typeof fetch,
      ...overrides
    }
  }

  it('does not fetch when no destination is configured', () => {
    configureErrorReporting(baseConfig())
    reportError({ category: 'x', message: 'boom' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the full payload to a generic endpoint', async () => {
    configureErrorReporting(baseConfig({ endpoint: 'https://example.com/report' }))
    reportError({ category: 'mcp', message: 'connection refused', stack: 'Error: refused\n at foo' })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.com/report')
    const body = JSON.parse(init.body as string)
    expect(body.kind).toBe('error')
    expect(body.deviceId).toBeTypeOf('string')
    expect(body.version).toBe('0.3.10')
    expect(body.platform).toBe('darwin')
    expect(body.arch).toBe('arm64')
    expect(body.appId).toBe('legalwork')
    expect(body.level).toBe('error')
    expect(body.category).toBe('mcp')
    expect(body.message).toBe('connection refused')
    expect(body.stack).toContain('at foo')
    expect(body.dedupKey).toBeTypeOf('string')
    expect(body.ts).toBeTypeOf('number')
  })

  it('truncates message and stack and never includes detail', async () => {
    configureErrorReporting(baseConfig({ endpoint: 'https://example.com/report' }))
    const longMessage = 'x'.repeat(600)
    const longStack = 'y'.repeat(2500)
    reportError({
      category: 'x',
      message: longMessage,
      stack: longStack
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.message.length).toBeLessThanOrEqual(501)
    expect(body.stack.length).toBeLessThanOrEqual(2001)
    expect('detail' in body).toBe(false)
  })

  it('swallows fetch failures', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    configureErrorReporting(baseConfig({ endpoint: 'https://example.com/report' }))
    expect(() => reportError({ category: 'x', message: 'boom' })).not.toThrow()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('swallows non-2xx responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))
    configureErrorReporting(baseConfig({ endpoint: 'https://example.com/report' }))
    expect(() => reportError({ category: 'x', message: 'boom' })).not.toThrow()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('deduplicates the same error within a session', async () => {
    configureErrorReporting(baseConfig({ endpoint: 'https://example.com/report' }))
    reportError({ category: 'x', message: 'boom' })
    reportError({ category: 'x', message: 'boom' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rate-limits distinct errors within a window', () => {
    configureErrorReporting(baseConfig({
      endpoint: 'https://example.com/report',
      maxPerWindow: 3,
      windowMs: 60_000
    }))
    for (let i = 0; i < 5; i += 1) {
      reportError({ category: 'x', message: `boom-${i}` })
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('posts to GitHub issues when repo and token are configured', async () => {
    configureErrorReporting(baseConfig({
      githubRepo: 'acme/legalwork-reports',
      githubToken: 'ghp_test123',
      githubLabels: ['bug-report', 'auto']
    }))
    reportError({ category: 'uncaught-exception', message: 'TypeError: n is not a function', stack: 'at x' })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/acme/legalwork-reports/issues')
    expect(init.headers.Authorization).toBe('Bearer ghp_test123')
    expect(init.headers.Accept).toBe('application/vnd.github+json')
    const body = JSON.parse(init.body as string)
    expect(body.title).toContain('uncaught-exception')
    expect(body.title).toContain('TypeError')
    expect(body.labels).toEqual(['bug-report', 'auto'])
    expect(body.body).toContain('deviceId')
  })

  it('reads the report destination from a bundled config file', async () => {
    // Simulate the packaged-app case: no env destination, only a config file.
    const configPath = join(dataDir, 'error-report.config.json')
    writeFileSync(configPath, JSON.stringify({
      githubRepo: 'acme/reports',
      githubToken: 'ghp_filetoken',
      githubLabels: ['bug-report']
    }), 'utf8')
    configureErrorReporting(baseConfig({ configPath }))
    reportError({ category: 'x', message: 'boom from packaged app' })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/repos/acme/reports/issues')
  })

  it('stays silent when config file is empty', () => {
    const configPath = join(dataDir, 'error-report.config.json')
    writeFileSync(configPath, JSON.stringify({}), 'utf8')
    configureErrorReporting(baseConfig({ configPath }))
    reportError({ category: 'x', message: 'boom' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prefers GitHub issues over the generic endpoint', async () => {
    configureErrorReporting(baseConfig({
      githubRepo: 'acme/reports',
      githubToken: 'ghp_test123',
      endpoint: 'https://example.com/report'
    }))
    reportError({ category: 'x', message: 'boom' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toContain('api.github.com')
  })
})
