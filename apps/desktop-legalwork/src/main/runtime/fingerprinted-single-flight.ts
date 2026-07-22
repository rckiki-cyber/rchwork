type PendingOperation = {
  fingerprint: string
  promise: Promise<void>
}

/**
 * Coalesces concurrent operations that target the same runtime settings.
 * A different fingerprint waits for the current operation to settle before
 * competing to become the next owner.
 */
export class FingerprintedSingleFlight {
  private pending: PendingOperation | null = null

  async run(fingerprint: string, operation: () => Promise<void>): Promise<void> {
    while (true) {
      const pending = this.pending
      if (pending) {
        if (pending.fingerprint === fingerprint) {
          return pending.promise
        }
        try {
          await pending.promise
        } catch {
          // A different configuration still needs its own attempt.
        }
        continue
      }

      const promise = Promise.resolve().then(operation)
      const entry: PendingOperation = { fingerprint, promise }
      this.pending = entry
      try {
        await promise
        return
      } finally {
        if (this.pending === entry) {
          this.pending = null
        }
      }
    }
  }
}
