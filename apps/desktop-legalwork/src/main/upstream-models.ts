import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getModelProviderProfile,
  getModelProviderSettings,
  listModelProviderModelIds,
  resolveLegalworkRuntimeSettings,
  type AppSettingsV1
} from '../shared/app-settings'
import { DEFAULT_COMPOSER_MODEL_IDS } from '../shared/default-composer-models'
import type { ModelProviderModelGroup } from '../shared/ds-gui-api'
import { upstreamOpenAiModelsUrl } from '../shared/openai-compat-url'

export type FetchUpstreamModelsResult =
  | { ok: true; modelIds: string[]; modelGroups?: ModelProviderModelGroup[] }
  | { ok: false; message: string }

export type FetchEndpointModelsResult =
  | { ok: true; modelIds: string[] }
  | { ok: false; message: string }

export type FetchEndpointModelsOptions = {
  providerId?: string
  endpointFormat?: string
}

const UPSTREAM_MODELS_TIMEOUT_MS = 8_000

/**
 * Fetch the raw model list from an arbitrary OpenAI-compatible endpoint.
 * Used by the settings page so the user can preview a provider's models
 * before the values are applied to the runtime.
 */
export async function fetchModelsForEndpoint(
  baseUrl: string,
  apiKey: string,
  options: FetchEndpointModelsOptions = {}
): Promise<FetchEndpointModelsResult> {
  const key = apiKey.trim()
  if (!key) return { ok: false, message: 'Missing API key; cannot query upstream /v1/models.' }
  const base = baseUrl.trim()
  if (!base) return { ok: false, message: 'Missing base URL; cannot query upstream /v1/models.' }
  const url = upstreamOpenAiModelsUrl(base)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: modelListHeaders(key, options),
      signal: AbortSignal.timeout(UPSTREAM_MODELS_TIMEOUT_MS)
    })
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, message: `Models request failed (${res.status}): ${text.slice(0, 400)}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      return { ok: false, message: 'Upstream /v1/models returned non-JSON body.' }
    }
    const data = (parsed as { data?: unknown }).data
    if (!Array.isArray(data)) {
      return { ok: false, message: 'Upstream /v1/models JSON missing data[] array.' }
    }
    const ids = new Set<string>()
    for (const row of data) {
      if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
        const id = (row as { id: string }).id.trim()
        if (id) ids.add(id)
      }
    }
    const sorted = [...ids]
      .filter((id) => isSelectableConversationModel(id))
      .sort((a, b) => a.localeCompare(b))
    if (sorted.length === 0) return { ok: false, message: 'Upstream returned an empty model list.' }
    return { ok: true, modelIds: sorted }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export function fallbackModelIds(): string[] {
  return ['auto']
}

export async function fetchUpstreamModelIds(
  settings: AppSettingsV1,
  _apiKey?: string
): Promise<FetchUpstreamModelsResult> {
  const configuredProviders = getModelProviderSettings(settings).providers.filter(
    (provider) => provider.apiKey.trim() && provider.baseUrl.trim()
  )
  if (configuredProviders.length === 0) {
    return { ok: false, message: 'No model provider API keys are configured.' }
  }

  const results = await Promise.all(configuredProviders.map(async (provider) => ({
    provider,
    result: await fetchModelsForEndpoint(provider.baseUrl, provider.apiKey, {
      providerId: provider.id,
      endpointFormat: provider.endpointFormat
    })
  })))
  const modelGroups = results.flatMap(({ provider, result }) => (
    result.ok
      ? [{ providerId: provider.id, label: provider.name, modelIds: result.modelIds }]
      : []
  ))
  if (modelGroups.length === 0) {
    const messages = results.map(({ provider, result }) => (
      `${provider.name}: ${result.ok ? 'no selectable conversation models' : result.message}`
    ))
    return { ok: false, message: messages.join('\n') }
  }
  return {
    ok: true,
    modelIds: sortComposerModelIds(['auto', ...modelGroups.flatMap((group) => group.modelIds)]),
    modelGroups
  }
}

function modelListHeaders(apiKey: string, options: FetchEndpointModelsOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`
  }
  if (options.endpointFormat?.trim() === 'messages' || options.providerId?.trim() === 'claude') {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  }
  return headers
}

/**
 * `/models` is an access list, not a chat-capability list. Exclude capability
 * families that Legalwork cannot send through its conversation endpoints while
 * keeping versioned/future text model ids fully dynamic.
 */
export function isSelectableConversationModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  if (!id) return false
  return !/(^|[-_/.])(embedding|rerank|moderation|whisper|tts|speech|transcrib|realtime|audio|image|dall-e|sora|video|ocr)([-_/.]|$)/.test(id)
    && !/^(babbage|davinci)-/.test(id)
    && !id.includes('computer-use')
}

export async function readConfiguredLegalworkModelIds(settings: AppSettingsV1): Promise<string[]> {
  const runtime = resolveLegalworkRuntimeSettings(settings)
  const configPath = join(expandHome(runtime.dataDir), 'config.json')
  const ids = [runtime.model, ...listModelProviderModelIds(settings)]
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown
  } catch {
    return mergeModelIds(ids)
  }
  const root = objectValue(parsed)
  const models = objectValue(root.models)
  const contextCompaction = objectValue(root.contextCompaction)
  return mergeModelIds([
    ...ids,
    ...modelIdsFromProfiles(objectValue(contextCompaction.modelProfiles)),
    ...modelIdsFromProfiles(objectValue(models.profiles))
  ])
}

function modelListOrError(
  ids: readonly string[],
  groups: readonly ModelProviderModelGroup[],
  message: string
): FetchUpstreamModelsResult {
  const customIds = customModelIds(ids)
  return customIds.length > 0
    ? {
        ok: true,
        modelIds: sortComposerModelIds(['auto', ...customIds]),
        modelGroups: mergeModelGroups(filterGroupsToCustomModels(groups))
      }
    : { ok: false, message }
}

async function readConfiguredModelGroups(settings: AppSettingsV1): Promise<ModelProviderModelGroup[]> {
  const groups: ModelProviderModelGroup[] = []
  for (const provider of getModelProviderSettings(settings).providers) {
    if (provider.models.length === 0) continue
    groups.push({
      providerId: provider.id,
      label: provider.name,
      modelIds: provider.models
    })
  }
  return mergeModelGroups([
    ...groups,
    ...(await readConfiguredProfileAliasGroups(settings, groups))
  ])
}

function mergeModelGroups(groups: readonly ModelProviderModelGroup[]): ModelProviderModelGroup[] {
  const byProvider = new Map<string, ModelProviderModelGroup>()
  for (const group of groups) {
    const providerId = group.providerId.trim()
    if (!providerId) continue
    const existing = byProvider.get(providerId)
    const modelIds = sortComposerModelIds([
      ...(existing?.modelIds ?? []),
      ...group.modelIds
    ]).filter((id) => id !== 'auto')
    byProvider.set(providerId, {
      providerId,
      label: group.label.trim() || providerId,
      modelIds
    })
  }
  return [...byProvider.values()].filter((group) => group.modelIds.length > 0)
}

function modelIdsFromProfiles(profiles: Record<string, unknown>): string[] {
  const ids: string[] = []
  for (const [modelId, rawProfile] of Object.entries(profiles)) {
    const trimmed = modelId.trim()
    if (trimmed) ids.push(trimmed)
    const aliases = objectValue(rawProfile).aliases
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias !== 'string') continue
        const trimmedAlias = alias.trim()
        if (trimmedAlias) ids.push(trimmedAlias)
      }
    }
  }
  return ids
}

async function readConfiguredProfileAliasGroups(
  settings: AppSettingsV1,
  providerGroups: readonly ModelProviderModelGroup[]
): Promise<ModelProviderModelGroup[]> {
  const runtime = resolveLegalworkRuntimeSettings(settings)
  const configPath = join(expandHome(runtime.dataDir), 'config.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown
  } catch {
    return []
  }
  const root = objectValue(parsed)
  const models = objectValue(root.models)
  const contextCompaction = objectValue(root.contextCompaction)
  const aliasesByModel = new Map<string, string[]>()
  collectModelProfileAliases(aliasesByModel, objectValue(contextCompaction.modelProfiles))
  collectModelProfileAliases(aliasesByModel, objectValue(models.profiles))

  const aliasGroups: ModelProviderModelGroup[] = []
  for (const group of providerGroups) {
    const aliases: string[] = []
    for (const modelId of group.modelIds) {
      aliases.push(...(aliasesByModel.get(modelId.trim()) ?? []))
    }
    if (aliases.length === 0) continue
    aliasGroups.push({
      providerId: group.providerId,
      label: group.label,
      modelIds: aliases
    })
  }
  return aliasGroups
}

function collectModelProfileAliases(
  target: Map<string, string[]>,
  profiles: Record<string, unknown>
): void {
  for (const [modelId, rawProfile] of Object.entries(profiles)) {
    const trimmed = modelId.trim()
    if (!trimmed) continue
    const aliases = objectValue(rawProfile).aliases
    if (!Array.isArray(aliases)) continue
    const ids = target.get(trimmed) ?? []
    for (const alias of aliases) {
      if (typeof alias !== 'string') continue
      const trimmedAlias = alias.trim()
      if (trimmedAlias) ids.push(trimmedAlias)
    }
    target.set(trimmed, ids)
  }
}

function mergeModelIds(ids: readonly string[]): string[] {
  return sortComposerModelIds([...DEFAULT_COMPOSER_MODEL_IDS, ...ids])
}

function customModelIds(ids: readonly string[]): string[] {
  const defaults = new Set<string>(DEFAULT_COMPOSER_MODEL_IDS)
  return ids.filter((id) => {
    const trimmed = id.trim()
    return trimmed !== '' && !defaults.has(trimmed as typeof DEFAULT_COMPOSER_MODEL_IDS[number])
  })
}

function filterGroupsToCustomModels(groups: readonly ModelProviderModelGroup[]): ModelProviderModelGroup[] {
  const defaults = new Set<string>(DEFAULT_COMPOSER_MODEL_IDS)
  return groups.map((group) => ({
    ...group,
    modelIds: group.modelIds.filter((id) => {
      const trimmed = id.trim()
      return trimmed !== '' && !defaults.has(trimmed as typeof DEFAULT_COMPOSER_MODEL_IDS[number])
    })
  }))
}

function sortComposerModelIds(ids: readonly string[]): string[] {
  const ordered = new Set<string>()
  for (const id of ids) {
    const trimmed = id.trim()
    if (trimmed) ordered.add(trimmed)
  }
  const tail = [...ordered].filter((id) => id !== 'auto').sort((a, b) => a.localeCompare(b))
  return ordered.has('auto') ? ['auto', ...tail] : tail
}

function expandHome(path: string): string {
  return path.startsWith('~') ? path.replace(/^~(?=$|[\\/])/, homedir()) : path
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
