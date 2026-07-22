import { afterEach, describe, expect, it, vi } from 'vitest'
import { continueAppQuitAfterCleanup } from './continue-app-quit'

afterEach(() => {
  vi.useRealTimers()
})

describe('continueAppQuitAfterCleanup', () => {
  it('continues quitting after cleanup finishes', async () => {
    const quit = vi.fn()

    continueAppQuitAfterCleanup({
      cleanup: async () => undefined,
      quit,
      forceAfterMs: 2_000
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('continues quitting after the deadline when cleanup is stuck', async () => {
    vi.useFakeTimers()
    const quit = vi.fn()

    continueAppQuitAfterCleanup({
      cleanup: () => new Promise<void>(() => undefined),
      quit,
      forceAfterMs: 2_000
    })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(quit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
