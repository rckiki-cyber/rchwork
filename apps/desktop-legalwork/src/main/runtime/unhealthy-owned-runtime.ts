export type OwnedRuntimeController = {
  isChildRunning(): boolean
  stopAndWait(): Promise<void>
}

/**
 * Stop a managed child that still owns the configured port but no longer
 * answers health checks. Port reclamation cannot fix this case because the
 * owner is this application itself.
 */
export type OwnedRuntimeRecoveryResult = 'not-owned' | 'became-healthy' | 'stopped'

export async function recoverUnhealthyOwnedRuntime(
  controller: OwnedRuntimeController,
  probeCoreApi: () => Promise<boolean>
): Promise<OwnedRuntimeRecoveryResult> {
  if (!controller.isChildRunning()) return 'not-owned'
  // A just-launched child can miss the fast probe. Give it one bounded chance
  // to finish starting before classifying it as hung.
  if (await probeCoreApi()) return 'became-healthy'
  await controller.stopAndWait()
  return 'stopped'
}
