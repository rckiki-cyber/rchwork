import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_PROBE_BUDGET_MS,
  withinRuntimeProbeBudget
} from './chat-store-navigation-actions'

afterEach(() => {
  vi.useRealTimers()
})

describe('withinRuntimeProbeBudget', () => {
  it('returns a healthy connection result before the deadline', async () => {
    await expect(withinRuntimeProbeBudget(Promise.resolve('ready'))).resolves.toBe('ready')
  })

  it('stops waiting after five seconds instead of staying in connecting', async () => {
    vi.useFakeTimers()
    const result = withinRuntimeProbeBudget(new Promise<never>(() => undefined))
    const assertion = expect(result).rejects.toThrow(/5/)

    await vi.advanceTimersByTimeAsync(RUNTIME_PROBE_BUDGET_MS)

    await assertion
  })
})
