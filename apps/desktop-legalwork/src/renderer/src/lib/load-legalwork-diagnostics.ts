import type {
  CoreMemoryRecordJson,
  CoreRuntimeInfoJson,
  CoreRuntimeToolDiagnosticsJson
} from '../agent/legalwork-contract'
import type { AgentProvider } from '../agent/types'
import { describeRuntimeError } from './format-runtime-error'

type DiagnosticsProvider = Pick<AgentProvider, 'getRuntimeInfo' | 'getToolDiagnostics' | 'listMemories'>

export type LoadedLegalworkDiagnostics = {
  runtimeInfo?: CoreRuntimeInfoJson | null
  toolDiagnostics?: CoreRuntimeToolDiagnosticsJson | null
  memoryRecords?: CoreMemoryRecordJson[]
  errors: string[]
}

export async function loadLegalworkDiagnostics(
  provider: DiagnosticsProvider,
  options: { workspace?: string } = {}
): Promise<LoadedLegalworkDiagnostics> {
  const [runtimeInfo, toolDiagnostics] = await Promise.allSettled([
    provider.getRuntimeInfo ? provider.getRuntimeInfo() : Promise.resolve(null),
    provider.getToolDiagnostics ? provider.getToolDiagnostics() : Promise.resolve(null)
  ])

  const loaded: LoadedLegalworkDiagnostics = { errors: [] }

  if (runtimeInfo.status === 'fulfilled') {
    loaded.runtimeInfo = runtimeInfo.value ?? null
  } else {
    loaded.errors.push(`Runtime: ${errorMessage(runtimeInfo.reason)}`)
  }

  if (toolDiagnostics.status === 'fulfilled') {
    loaded.toolDiagnostics = toolDiagnostics.value ?? null
  } else {
    loaded.errors.push(`Tools: ${errorMessage(toolDiagnostics.reason)}`)
  }

  const memoryRecords = await loadMemoryRecords(provider, loaded.runtimeInfo, options)
  if (memoryRecords.status === 'fulfilled') {
    loaded.memoryRecords = memoryRecords.value ?? []
  } else {
    loaded.errors.push(`Memory: ${errorMessage(memoryRecords.reason)}`)
  }

  loaded.errors = [...new Set(loaded.errors)]
  return loaded
}

function shouldLoadMemoryRecords(runtimeInfo: CoreRuntimeInfoJson | null | undefined): boolean {
  const memoryStatus = runtimeInfo?.capabilities?.memory?.status
  if (!memoryStatus) return true
  return memoryStatus === 'available'
}

async function loadMemoryRecords(
  provider: DiagnosticsProvider,
  runtimeInfo: CoreRuntimeInfoJson | null | undefined,
  options: { workspace?: string }
): Promise<PromiseSettledResult<CoreMemoryRecordJson[]>> {
  if (!provider.listMemories || !shouldLoadMemoryRecords(runtimeInfo)) {
    return Promise.resolve({ status: 'fulfilled', value: [] })
  }
  return Promise.resolve(
    provider.listMemories({ workspace: options.workspace, includeDeleted: false })
  ).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  )
}

function errorMessage(error: unknown): string {
  return describeRuntimeError(error).summary
}
