import { join, posix } from 'node:path'
import {
  resolveClawScheduleMcpCommand,
  type ClawScheduleMcpLaunchConfig
} from './claw-schedule-mcp-config'

/**
 * filesystem MCP 的离线启动配置。
 *
 * 用户配置里 filesystem 默认是 `npx -y @modelcontextprotocol/server-filesystem <目录>`，
 * npx 每次启动都要联网检查 npm registry，网络不通时在 connect_timeout 内连不上。
 * 这里把命令改写为用 legalwork 自带 node（ELECTRON_RUN_AS_NODE）直接跑
 * `out/main/filesystem-mcp-node-entry.cjs`，纯本地、零网络依赖。
 */

export const FILESYSTEM_MCP_SERVER_NAME = 'filesystem'
const FILESYSTEM_MCP_NODE_ENTRY = 'out/main/filesystem-mcp-node-entry.cjs'
const ELECTRON_RUN_AS_NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' }

type JsonRecord = Record<string, unknown>

export function resolveFilesystemMcpEntryPath(launch: ClawScheduleMcpLaunchConfig): string {
  if (launch.appPath.includes('/') && !launch.appPath.includes('\\')) {
    return posix.join(launch.appPath, FILESYSTEM_MCP_NODE_ENTRY)
  }
  return join(launch.appPath, FILESYSTEM_MCP_NODE_ENTRY)
}

/** 是否 npx 方式的官方 server-filesystem 配置（命令或参数里同时出现 npx 与 server-filesystem）。 */
export function isNpxFilesystemServer(server: JsonRecord): boolean {
  const command = typeof server.command === 'string' ? server.command : ''
  const args = Array.isArray(server.args)
    ? server.args.filter((item): item is string => typeof item === 'string')
    : []
  const commandText = [command, ...args].join(' ')
  return commandText.includes('npx') && commandText.includes('server-filesystem')
}

const FILESYSTEM_MCP_TIMEOUT_MS = 60_000

export function buildFilesystemMcpServerConfig(
  launch: ClawScheduleMcpLaunchConfig,
  workspaceRoots: string[],
  extraEnv?: JsonRecord
): JsonRecord {
  const userEnv = extraEnv && typeof extraEnv === 'object'
    ? Object.fromEntries(
        Object.entries(extraEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    : {}
  return {
    enabled: true,
    transport: 'stdio',
    command: resolveClawScheduleMcpCommand(launch),
    args: [resolveFilesystemMcpEntryPath(launch), ...workspaceRoots],
    env: { ...userEnv, ...ELECTRON_RUN_AS_NODE_ENV },
    trustScope: 'user',
    timeoutMs: FILESYSTEM_MCP_TIMEOUT_MS
  }
}

/**
 * 把 npx 方式的 filesystem 配置改写为离线启动；保留原 args 里的所有允许目录与用户自定义 env。
 * 不匹配（非 npx / 无允许目录）时返回 null，保持原配置不动。
 */
export function rewriteNpxFilesystemMcpServer(
  server: JsonRecord,
  launch: ClawScheduleMcpLaunchConfig
): JsonRecord | null {
  if (!isNpxFilesystemServer(server)) return null
  const args = Array.isArray(server.args)
    ? server.args.filter((item): item is string => typeof item === 'string')
    : []
  const workspaceRoots = args.filter(
    (arg) => arg.trim().length > 0 && !arg.includes('npx') && !arg.includes('server-filesystem') && !arg.startsWith('-')
  )
  if (workspaceRoots.length === 0) return null
  const env = server.env && typeof server.env === 'object' ? (server.env as JsonRecord) : {}
  return buildFilesystemMcpServerConfig(launch, workspaceRoots, env)
}
