import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/tmp/legalwork-app'),
    getPath: vi.fn(() => '/tmp/legalwork-user-data')
  },
  BrowserWindow: class {}
}))

describe('Codex quota parsing', () => {
  it('maps ChatGPT quota windows, balances, and reset credits', async () => {
    const { parseCodexQuota } = await import('./codex-auth-manager')
    const quota = parseCodexQuota({
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: {
            usedPercent: 73.25,
            windowDurationMins: 300,
            resetsAt: 1_786_176_438
          },
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: '12.5'
          },
          planType: 'plus',
          rateLimitReachedType: null
        }
      },
      rateLimitResetCredits: { availableCount: 2 }
    })

    expect(quota).toEqual({
      buckets: [{
        limitId: 'codex',
        limitName: null,
        planType: 'plus',
        primary: {
          usedPercent: 73.25,
          windowDurationMins: 300,
          resetsAt: 1_786_176_438
        },
        secondary: null,
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: '12.5'
        },
        rateLimitReachedType: null
      }],
      resetCreditsAvailable: 2
    })
  })

  it('clamps invalid percentages and supports the legacy single-bucket view', async () => {
    const { parseCodexQuota } = await import('./codex-auth-manager')
    const quota = parseCodexQuota({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 130, windowDurationMins: 10_080, resetsAt: null }
      }
    })

    expect(quota?.buckets[0]?.primary).toEqual({
      usedPercent: 100,
      windowDurationMins: 10_080,
      resetsAt: null
    })
  })
})

describe('friendlyChatgptErrorMessage', () => {
  it('maps reqwest transport errors to a friendly network message', async () => {
    const { friendlyChatgptErrorMessage } = await import('./codex-auth-manager')
    expect(
      friendlyChatgptErrorMessage('Tokenexchange failed:error sending request (https://auth.openai.com/oauth/token)')
    ).toBe('无法连接到 OpenAI 服务器，请检查网络或代理设置后重试。')
  })

  it('leaves account-level errors untouched', async () => {
    const { friendlyChatgptErrorMessage } = await import('./codex-auth-manager')
    expect(friendlyChatgptErrorMessage('invalid_grant: The authorization code is invalid.')).toBe(
      'invalid_grant: The authorization code is invalid.'
    )
  })

  it('maps connection/timeout failures', async () => {
    const { friendlyChatgptErrorMessage } = await import('./codex-auth-manager')
    expect(friendlyChatgptErrorMessage('connection timed out')).toBe(
      '无法连接到 OpenAI 服务器，请检查网络或代理设置后重试。'
    )
    expect(friendlyChatgptErrorMessage('Failed to resolve host (dns error)')).toBe(
      '无法连接到 OpenAI 服务器，请检查网络或代理设置后重试。'
    )
  })
})

describe('mergeProxyEnv', () => {
  it('injects the detected system proxy when nothing is set', async () => {
    const { mergeProxyEnv } = await import('./codex-auth-manager')
    const merged = mergeProxyEnv(
      {},
      { HTTPS_PROXY: 'http://127.0.0.1:1082', HTTP_PROXY: 'http://127.0.0.1:1082', NO_PROXY: 'localhost' }
    )
    expect(merged).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:1082',
      HTTP_PROXY: 'http://127.0.0.1:1082',
      NO_PROXY: 'localhost'
    })
  })

  it('never overrides an explicit user proxy', async () => {
    const { mergeProxyEnv } = await import('./codex-auth-manager')
    const merged = mergeProxyEnv(
      { HTTPS_PROXY: 'http://corp:8080' },
      { HTTPS_PROXY: 'http://127.0.0.1:1082', HTTP_PROXY: 'http://127.0.0.1:1082' }
    )
    // HTTPS_PROXY is already set by the user, so it is not overridden
    expect(merged?.HTTPS_PROXY).toBeUndefined()
    // HTTP_PROXY was not set by the user, so it is injected
    expect(merged?.HTTP_PROXY).toBe('http://127.0.0.1:1082')
  })

  it('returns undefined when no system proxy is configured', async () => {
    const { mergeProxyEnv } = await import('./codex-auth-manager')
    expect(mergeProxyEnv({}, null)).toBeUndefined()
  })
})
