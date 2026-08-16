import type {
  CoreRuntimeCapabilityManifestJson,
  CoreRuntimeInfoJson
} from '../agent/legalwork-contract'

export type AttachmentUploadAvailabilityInput = {
  runtimeConnection: string
  route: string
  mode: 'plan' | 'agent'
  attachmentStoreAvailable?: boolean
}

export type ResolvedAttachmentCapabilities = {
  capabilities: CoreRuntimeCapabilityManifestJson['attachments']
  runtimeInfo?: CoreRuntimeInfoJson
}

export function isChatAttachmentUploadEnabled(input: AttachmentUploadAvailabilityInput): boolean {
  return (
    input.runtimeConnection === 'ready' &&
    input.route === 'chat' &&
    (input.mode === 'agent' || input.mode === 'plan') &&
    // The desktop-managed runtime enables attachments by default. Runtime
    // capability discovery can briefly time out during startup; an unknown
    // result must not permanently hide the file picker for the whole session.
    // Still honor an explicit unavailable result from a completed probe.
    input.attachmentStoreAvailable !== false
  )
}

/**
 * Resolve the capability manifest at the moment an upload starts. The
 * workbench's eager startup probe is intentionally best-effort and can time
 * out while the freshly spawned runtime is still warming up, so its cached
 * value is not sufficient for deciding whether an actual click may upload.
 */
export async function resolveChatAttachmentCapabilities(input: {
  cached?: CoreRuntimeCapabilityManifestJson['attachments']
  loadRuntimeInfo?: () => Promise<CoreRuntimeInfoJson>
}): Promise<ResolvedAttachmentCapabilities | null> {
  if (input.cached?.available === true) {
    return { capabilities: input.cached }
  }
  if (input.cached?.available === false || !input.loadRuntimeInfo) {
    return null
  }
  const runtimeInfo = await input.loadRuntimeInfo()
  const capabilities = runtimeInfo.capabilities.attachments
  if (capabilities.available !== true) return null
  return { capabilities, runtimeInfo }
}
