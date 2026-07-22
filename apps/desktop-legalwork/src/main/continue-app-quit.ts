export type ContinueAppQuitOptions = {
  cleanup: () => Promise<void>
  quit: () => void
  forceAfterMs: number
  onCleanupError?: (error: unknown) => void
}

/** Continue a previously prevented Electron quit after cleanup or timeout. */
export function continueAppQuitAfterCleanup(options: ContinueAppQuitOptions): void {
  let continued = false
  const continueQuit = (): void => {
    if (continued) return
    continued = true
    options.quit()
  }
  const timer = setTimeout(continueQuit, options.forceAfterMs)

  void options.cleanup()
    .catch((error: unknown) => {
      options.onCleanupError?.(error)
    })
    .finally(() => {
      clearTimeout(timer)
      continueQuit()
    })
}
