import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { McpServerConfig } from '../../contracts/capabilities.js'
import { REDACTED_SECRET } from '../../config/secret-redaction.js'

const PKULAW_FALLBACK_FILENAME = 'pkulaw-fallback.auth'
const PKULAW_FALLBACK_FORMAT_VERSION = 1
const PKULAW_FALLBACK_KEY_CONTEXT = 'legalwork:pkulaw-fallback:v1'

const PKULAW_MCP_ENDPOINTS = new Set([
  'https://apim-gateway.pkulaw.com/mcp-law-search-service',
  'https://apim-gateway.pkulaw.com/mcp-law',
  'https://apim-gateway.pkulaw.com/mcp-fatiao',
  'https://apim-gateway.pkulaw.com/pku_citation_validator',
  'https://apim-gateway.pkulaw.com/add-doc-link',
  'https://apim-gateway.pkulaw.com/law_recognition',
  'https://apim-gateway.pkulaw.com/case_number_recognition',
  'https://apim-gateway.pkulaw.com/mcp-case',
  'https://apim-gateway.pkulaw.com/mcp-case-search-service'
])

type BundledCredentialPayload = {
  v: number
  salt: string
  data: string
}

let cachedBundledToken: string | undefined
let bundledTokenResolved = false

/**
 * Resolve the application-managed PKULaw fallback credential.
 *
 * The build places an opaque payload next to this compiled module. The token is
 * never written to user MCP config, diagnostics, or renderer state. An env value
 * is supported for development and controlled deployments.
 */
export function resolveBundledPkulawToken(): string | undefined {
  const fromEnv = normalizeToken(process.env.LEGALWORK_PKULAW_FALLBACK_TOKEN)
  if (fromEnv) return fromEnv
  if (bundledTokenResolved) return cachedBundledToken

  bundledTokenResolved = true
  try {
    const url = new URL(`./${PKULAW_FALLBACK_FILENAME}`, import.meta.url)
    const payload = JSON.parse(readFileSync(url, 'utf8')) as BundledCredentialPayload
    cachedBundledToken = decodeBundledCredential(payload)
  } catch {
    cachedBundledToken = undefined
  }
  return cachedBundledToken
}

export function createPkulawConnectionCandidates(
  server: McpServerConfig,
  fallbackToken: string | undefined
): McpServerConfig[] {
  const normalizedFallback = normalizeToken(fallbackToken)
  if (!normalizedFallback || !isBundledPkulawEndpoint(server)) return [server]

  const userAuthorization = authorizationHeader(server.headers)
  const userToken = bearerToken(userAuthorization)
  const fallbackServer = withAuthorization(server, `Bearer ${normalizedFallback}`)

  if (!userToken || userToken === normalizedFallback) return [server, fallbackServer]
  return [server, fallbackServer]
}

export function isBundledPkulawEndpoint(server: McpServerConfig): boolean {
  if (server.transport !== 'streamable-http' || !server.url) return false
  try {
    const parsed = new URL(server.url)
    if (parsed.protocol !== 'https:') return false
    parsed.hash = ''
    parsed.search = ''
    return PKULAW_MCP_ENDPOINTS.has(parsed.toString().replace(/\/$/, ''))
  } catch {
    return false
  }
}

function authorizationHeader(headers: Record<string, string>): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')
  return entry?.[1]
}

function bearerToken(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^Bearer\s+(.+)$/i)
  if (!match?.[1]) return undefined
  return normalizeToken(match[1])
}

function normalizeToken(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (!normalized || normalized.includes('${') || /\s/.test(normalized)) return undefined
  if (normalized === REDACTED_SECRET || normalized.length < 16) return undefined
  return normalized
}

function withAuthorization(server: McpServerConfig, authorization: string): McpServerConfig {
  const headers = Object.fromEntries(
    Object.entries(server.headers).filter(([key]) => key.toLowerCase() !== 'authorization')
  )
  return {
    ...server,
    headers: {
      ...headers,
      Authorization: authorization
    }
  }
}

function decodeBundledCredential(payload: BundledCredentialPayload): string | undefined {
  if (payload.v !== PKULAW_FALLBACK_FORMAT_VERSION) return undefined
  if (typeof payload.salt !== 'string' || typeof payload.data !== 'string') return undefined
  const salt = Buffer.from(payload.salt, 'base64')
  const encrypted = Buffer.from(payload.data, 'base64')
  if (salt.length < 16 || encrypted.length < 16) return undefined

  const key = createHash('sha256')
    .update(PKULAW_FALLBACK_KEY_CONTEXT)
    .update(salt)
    .digest()
  const decoded = Buffer.allocUnsafe(encrypted.length)
  for (let index = 0; index < encrypted.length; index += 1) {
    decoded[index] = encrypted[index]! ^ key[index % key.length]!
  }
  return normalizeToken(decoded.toString('utf8'))
}
