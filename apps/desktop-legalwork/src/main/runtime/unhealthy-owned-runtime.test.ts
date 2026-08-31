import { describe, expect, it, vi } from 'vitest'
import { recoverUnhealthyOwnedRuntime } from './unhealthy-owned-runtime'

describe('recoverUnhealthyOwnedRuntime', () => {
  it('stops a managed child that failed its health probe', async () => {
    const stopAndWait = vi.fn(async () => {})

    await expect(recoverUnhealthyOwnedRuntime({
      isChildRunning: () => true,
      stopAndWait
    }, async () => false)).resolves.toBe('stopped')
    expect(stopAndWait).toHaveBeenCalledOnce()
  })

  it('allows a managed child that completes startup during the late probe', async () => {
    const stopAndWait = vi.fn(async () => {})

    await expect(recoverUnhealthyOwnedRuntime({
      isChildRunning: () => true,
      stopAndWait
    }, async () => true)).resolves.toBe('became-healthy')
    expect(stopAndWait).not.toHaveBeenCalled()
  })

  it('leaves an externally owned port for the port-conflict path', async () => {
    const stopAndWait = vi.fn(async () => {})

    await expect(recoverUnhealthyOwnedRuntime({
      isChildRunning: () => false,
      stopAndWait
    }, async () => false)).resolves.toBe('not-owned')
    expect(stopAndWait).not.toHaveBeenCalled()
  })
})
