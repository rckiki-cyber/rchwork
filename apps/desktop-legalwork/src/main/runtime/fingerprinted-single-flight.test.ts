import { describe, expect, it, vi } from 'vitest'
import { FingerprintedSingleFlight } from './fingerprinted-single-flight'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('FingerprintedSingleFlight', () => {
  it('shares one failed attempt with concurrent callers using the same fingerprint', async () => {
    const gate = deferred()
    const operation = vi.fn(() => gate.promise)
    const singleFlight = new FingerprintedSingleFlight()

    const calls = Array.from({ length: 50 }, () => singleFlight.run('same', operation))
    await Promise.resolve()
    expect(operation).toHaveBeenCalledTimes(1)

    gate.reject(new Error('runtime unavailable'))
    const results = await Promise.allSettled(calls)

    expect(operation).toHaveBeenCalledTimes(1)
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
  })

  it('serializes a new fingerprint and coalesces callers waiting for it', async () => {
    const first = deferred()
    const second = deferred()
    const firstOperation = vi.fn(() => first.promise)
    const secondOperation = vi.fn(() => second.promise)
    const duplicateSecondOperation = vi.fn(() => Promise.resolve())
    const singleFlight = new FingerprintedSingleFlight()

    const firstCall = singleFlight.run('first', firstOperation)
    const secondCall = singleFlight.run('second', secondOperation)
    const duplicateSecondCall = singleFlight.run('second', duplicateSecondOperation)
    await Promise.resolve()

    expect(firstOperation).toHaveBeenCalledTimes(1)
    expect(secondOperation).not.toHaveBeenCalled()
    first.resolve()
    await firstCall
    await Promise.resolve()

    expect(secondOperation).toHaveBeenCalledTimes(1)
    expect(duplicateSecondOperation).not.toHaveBeenCalled()
    second.resolve()
    await Promise.all([secondCall, duplicateSecondCall])
  })
})
