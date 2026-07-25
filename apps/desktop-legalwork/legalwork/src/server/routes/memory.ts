import {
  MemoryCategory,
  MemoryCreateRequest,
  MemoryRecordState,
  MemoryScope,
  MemoryUpdateRequest
} from '../../contracts/memory.js'
import { MemoryPolicyError } from '../../memory/memory-policy.js'
import type { MemoryStore } from '../../memory/memory-store.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { ERRORS } from './runtime-error.js'

export async function listMemories(store: MemoryStore | undefined, request: Request): Promise<JsonResponse> {
  if (!store) return ERRORS.unavailable('memory store is unavailable')
  const url = new URL(request.url)
  const scope = optionalEnum(MemoryScope, url.searchParams.get('scope'))
  const category = optionalEnum(MemoryCategory, url.searchParams.get('category'))
  const state = optionalEnum(MemoryRecordState, url.searchParams.get('state'))
  if (!scope.ok || !category.ok || !state.ok) {
    return ERRORS.validation('invalid memory list filter')
  }
  const limit = optionalInteger(url.searchParams.get('limit'))
  const offset = optionalInteger(url.searchParams.get('offset'))
  if (!limit.ok || !offset.ok) return ERRORS.validation('invalid memory list pagination')
  return jsonResponse(await store.listPage({
      workspace: url.searchParams.get('workspace') ?? undefined,
      project: url.searchParams.get('project') ?? undefined,
      includeDeleted: url.searchParams.get('include_deleted') === 'true',
      query: url.searchParams.get('query') ?? undefined,
      scope: scope.value,
      category: category.value,
      state: state.value,
      limit: limit.value,
      offset: offset.value
    }))
}

export async function createMemory(store: MemoryStore | undefined, request: Request): Promise<JsonResponse | Response> {
  if (!store) return ERRORS.unavailable('memory store is unavailable')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = MemoryCreateRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid memory create body', parsed.error.issues)
  try {
    return jsonResponse({ memory: await store.create(parsed.data) }, 201)
  } catch (error) {
    return memoryMutationError(error)
  }
}

export async function updateMemory(store: MemoryStore | undefined, id: string, request: Request): Promise<JsonResponse | Response> {
  if (!store) return ERRORS.unavailable('memory store is unavailable')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = MemoryUpdateRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid memory update body', parsed.error.issues)
  try {
    return jsonResponse({ memory: await store.update(id, parsed.data) })
  } catch (error) {
    return memoryMutationError(error)
  }
}

export async function deleteMemory(
  store: MemoryStore | undefined,
  id: string,
  request: Request
): Promise<JsonResponse> {
  if (!store) return ERRORS.unavailable('memory store is unavailable')
  try {
    if (new URL(request.url).searchParams.get('permanent') === 'true') {
      return jsonResponse(await store.purge(id))
    }
    return jsonResponse({ memory: await store.delete(id) })
  } catch (error) {
    return memoryMutationError(error)
  }
}

export async function memoryDiagnostics(store: MemoryStore | undefined): Promise<JsonResponse> {
  if (!store) return jsonResponse({ enabled: false, rootDir: '', activeCount: 0, tombstoneCount: 0, lastInjectedIds: [] })
  return jsonResponse(await store.diagnostics())
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function memoryMutationError(error: unknown): JsonResponse {
  const message = errorMessage(error)
  if (error instanceof MemoryPolicyError) {
    return error.code === 'confirmation_required'
      ? ERRORS.conflict(message)
      : ERRORS.validation(message)
  }
  if (message.startsWith('memory not found:')) return ERRORS.notFound(message)
  if (message.startsWith('memory must be deleted before')) return ERRORS.conflict(message)
  return ERRORS.validation(message)
}

function optionalEnum<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: string | null
): { ok: true; value?: T } | { ok: false } {
  if (value === null || value === '') return { ok: true }
  const parsed = schema.safeParse(value)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false }
}

function optionalInteger(
  value: string | null
): { ok: true; value?: number } | { ok: false } {
  if (value === null || value === '') return { ok: true }
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0
    ? { ok: true, value: parsed }
    : { ok: false }
}
