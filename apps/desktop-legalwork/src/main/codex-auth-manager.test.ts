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
